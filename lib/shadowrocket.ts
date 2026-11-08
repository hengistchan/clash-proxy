import { splitCommonFields } from './config-storage-model';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { RE2JS } from 're2js';
import { BUILTIN_POLICIES, isJsonObject, type JsonObject, type Snapshot, type ValidationIssue } from './types';
import { validateSnapshot } from './validation';
import type { RemoteResources, RemoteSource } from './shadowrocket-sources';
import { SHADOWROCKET_BUILTINS } from './types';
import { unsafeConfLine } from './shadowrocket-import';

export const SHADOWROCKET_COMPILER_VERSION = 3;
const MAX_RULES = 50_000;
const MAX_MEMBERS = 50_000;
const MAX_FILTER_EVALUATIONS = 250_000;
const MAX_CONF_BYTES = 8 * 1024 * 1024;
const MAX_ISSUES = 100;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;
const RESERVED_POLICIES = new Set([...BUILTIN_POLICIES, 'PROXY', 'REJECT-TINYGIF', 'REJECT-DICT', 'REJECT-ARRAY', 'REJECT-200', 'REJECT-IMG', 'REJECT-NO-DROP']);
const RULE_TYPES = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'GEOIP', 'IP-ASN', 'DST-PORT', 'SRC-PORT']);
const NO_RESOLVE_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'IP-ASN']);
const CIPHERS = new Set(['aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305']);

export interface ShadowrocketArtifact {
  conf: string;
  filename: string;
  sha256: string;
  ruleCount: number;
}

type Report = { issues: ValidationIssue[]; artifact: ShadowrocketArtifact | null; sources: RemoteSource[] };
type Diagnose = (code: string, message: string, resource?: string, resourceId?: number, severity?: 'error' | 'warning') => void;

// Values are written to a line-based, comma-delimited format without quoting.
function atom(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    !/[,;#"\\\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u.test(value);
}

function policyName(value: string) {
  return atom(value) && !/[=\[\]]/.test(value);
}

function httpUrl(value: unknown): value is string {
  if (!atom(value) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function cidrType(value: string) {
  const [address, prefix, extra] = value.split('/');
  if (extra !== undefined || !address || address.includes('%')) return null;
  const version = isIP(address);
  if (!version || !/^\d{1,3}$/.test(prefix ?? '') || Number(prefix) > (version === 4 ? 32 : 128)) return null;
  return version === 4 ? 'IP-CIDR' : 'IP-CIDR6';
}

function rulePayload(type: string, payload: string) {
  if (!atom(payload)) return false;
  if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') return DOMAIN.test(payload);
  if (type === 'DOMAIN-KEYWORD') return /^[a-z\d.-]+$/i.test(payload);
  if (type === 'GEOIP') return /^[a-z]{2}$/i.test(payload);
  if (type === 'IP-ASN') return /^[1-9]\d{0,9}$/.test(payload) && Number(payload) <= 4_294_967_295;
  if (type === 'DST-PORT' || type === 'SRC-PORT') return /^[1-9]\d{0,4}$/.test(payload) && Number(payload) <= 65_535;
  return cidrType(payload) === type;
}

function noExtra(config: JsonObject, fields: string[]) {
  return Object.keys(config).every((key) => fields.includes(key));
}

function shadowsocksCipher(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/^aead_/, '').replaceAll('_', '-');
  return CIPHERS.has(normalized) ? normalized : null;
}

function nodeLine(node: Snapshot['proxies'][number], name: string) {
  const { config, type } = node;
  const { server, port, username, password, udp } = config;
  if (!atom(server) || !(DOMAIN.test(server) || (isIP(server) !== 0 && !server.includes('%'))) ||
    typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 ||
    (udp !== undefined && typeof udp !== 'boolean')) return null;
  const parts = [type, server, String(port)];
  const common = ['server', 'port'];
  if (type === 'ss') {
    const cipher = shadowsocksCipher(config.cipher);
    if (!noExtra(config, [...common, 'cipher', 'password', 'udp', 'plugin', 'plugin-opts', 'udp-over-tcp']) ||
      (config['udp-over-tcp'] !== undefined && config['udp-over-tcp'] !== false) ||
      !cipher || !atom(password) || /\s/.test(password)) return null;
    parts.push(`encrypt-method=${cipher}`, `password=${password}`);
    if (udp !== undefined) parts.push(`udp-relay=${udp}`);
    if (config.plugin !== undefined || config['plugin-opts'] !== undefined) {
      const options = config['plugin-opts'];
      if (config.plugin !== 'obfs' || !isJsonObject(options) || !noExtra(options, ['mode', 'host']) ||
        (options.mode !== 'http' && options.mode !== 'tls') ||
        (options.host !== undefined && (!atom(options.host) || !DOMAIN.test(options.host)))) return null;
      parts.push(`obfs=${options.mode}`);
      if (options.host !== undefined) parts.push(`obfs-host=${options.host}`);
    }
  } else if (type === 'http' || type === 'socks5') {
    if (!noExtra(config, [...common, 'username', 'password']) ||
      ((username !== undefined || password !== undefined) &&
        (!atom(username) || !atom(password) || /\s/.test(username + password)))) return null;
    if (username !== undefined) parts.push(`username=${username}`, `password=${password}`);
  } else {
    return null;
  }
  return `${name} = ${parts.join(', ')}`;
}

function groupBenchmark(group: Snapshot['proxyGroups'][number], providers: JsonObject[], hasDirectMembers: boolean): JsonObject | null {
  const config = { ...group.config };
  if (group.type === 'select' || !providers.length) return config;
  for (const field of ['benchmark-url', 'benchmark-timeout'] as const) {
    const configured = config[field] ?? (field === 'benchmark-url' ? config.url : undefined);
    const values = new Set(providers.map((provider) => provider[field] ?? configured));
    if (hasDirectMembers || configured !== undefined) values.add(configured);
    if (values.size > 1) return null;
    const [value] = values;
    if (configured === undefined && value !== undefined) config[field] = value;
  }
  return config;
}

function groupLine(group: Snapshot['proxyGroups'][number], name: string, policies: (string | undefined)[], resolve: (value: string) => string | undefined) {
  const { type, config } = group;
  const native = group.clientOptions?.shadowrocket;
  if (!['select', 'url-test', 'fallback', 'load-balance'].includes(type)) return null;
  const manual = type === 'select';
  const fields = ['proxies', 'use', 'hidden', 'icon', 'filter', ...(manual ? [] : ['interval', 'tolerance', 'url', 'benchmark-url', 'benchmark-timeout', 'lazy']), ...(type === 'load-balance' ? ['strategy'] : [])];
  if (!noExtra(config, fields) || (config.use !== undefined && !Array.isArray(config.use)) ||
    (config.hidden !== undefined && typeof config.hidden !== 'boolean') ||
    (config.lazy !== undefined && typeof config.lazy !== 'boolean') ||
    (type === 'load-balance' && config.strategy !== 'consistent-hashing')) return null;
  if ((!policies.length && typeof native?.['policy-regex-filter'] !== 'string') || policies.some((policy) => policy === undefined)) return null;
  const fieldsOut = [type, ...policies];
  if (config.hidden === true) fieldsOut.push('hidden=1');
  if (native) {
    if (!noExtra(native, ['policy-regex-filter', 'policy-select-name', 'select', 'use', 'nativeMembers'])) return null;
    for (const key of ['policy-regex-filter', 'policy-select-name'] as const) {
      const value = native[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value.trim() || unsafeConfLine.test(value) || /[,;#"']/.test(value) ||
        (key === 'policy-select-name' && !policyName(value))) return null;
      fieldsOut.push(`${key}=${key === 'policy-select-name' ? resolve(value) ?? value : value}`);
    }
    if (native.select !== undefined) {
      if (typeof native.select !== 'number' || !Number.isInteger(native.select) || native.select < 0 || native.select > 4000) return null;
      fieldsOut.push(`select=${native.select}`);
    }
    if (native.use !== undefined) {
      if (typeof native.use !== 'boolean') return null;
      fieldsOut.push(`use=${native.use}`);
    }
  }
  if (!manual) {
    if (config.url !== undefined && config['benchmark-url'] !== undefined) return null;
    const url = config['benchmark-url'] ?? config.url;
    if (url !== undefined) {
      if (!httpUrl(url)) return null;
      fieldsOut.push(`url=${url}`);
    }
    for (const [key, output, min] of [['interval', 'interval', 1], ['tolerance', 'tolerance', 0], ['benchmark-timeout', 'timeout', 1]] as const) {
      const value = config[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || (key === 'tolerance' && type !== 'url-test')) return null;
      fieldsOut.push(`${output}=${value}`);
    }
    if (config.interval === undefined) fieldsOut.push('interval=600');
  }
  return `${name} = ${fieldsOut.join(', ')}`;
}

function generalLines(snapshot: Snapshot, diagnose: Diagnose) {
  const lines: string[] = [];
  if (snapshot.profile.mode !== 'rule') diagnose('mode', '只支持规则模式。请在设置中选择规则模式。', 'settings');
  if (snapshot.profile.ipv6 !== null) lines.push(`ipv6 = ${snapshot.profile.ipv6}`);
  const dns = snapshot.profile.settings.dns;
  if (dns === undefined) return lines;
  if (!isJsonObject(dns)) {
    diagnose('dns', 'DNS 设置必须是一个映射。', 'dns');
    return lines;
  }
  const { common, stash } = splitCommonFields('dns', dns);
  if (stash['fake-ip-range'] !== undefined || stash['fake-ip-filter'] !== undefined) {
    diagnose('dns.fake-ip', 'Stash 的 Fake IP 地址池和过滤规则没有已验证的等价写法，不能自动转换。', 'dns');
  }
  if (!noExtra(stash, ['fake-ip-range', 'fake-ip-filter'])) {
    diagnose('dns', '配置包含无法自动转换的 DNS 策略。', 'dns');
  }
  for (const [key, original, target] of [
    ['resolvers', 'nameserver', 'dns-server'], ['proxyHostResolvers', 'proxy-server-nameserver', 'proxy-dns-server']
  ] as const) {
    const nameservers = common[key];
    if (nameservers === undefined) continue;
    if (!Array.isArray(nameservers) || !nameservers.length || !nameservers.every((value) => atom(value) && (
      value === 'system' || (isIP(value) !== 0 && !value.includes('%')) || (httpUrl(value) && value.startsWith('https://'))
    ))) diagnose('dns.nameserver', `${original} 仅支持 system、IP 地址或 HTTPS DNS 地址。`, 'dns');
    else lines.push(`${target} = ${nameservers.join(', ')}`);
  }
  if (common.resolvers !== undefined || common.proxyHostResolvers !== undefined) {
    diagnose('dns.runtime', '已分别转换普通 DNS 和节点域名解析设置。客户端的 DNS 回退和缓存行为可能不同，请在设备上验证。', 'dns', undefined, 'warning');
  }
  return lines;
}

function ruleSetEntry(behavior: string, entry: string, outerNoResolve: boolean) {
  if (behavior === 'classical') {
    const [type, payload, option, ...extra] = entry.split(',').map((part) => part.trim());
    const noResolve = outerNoResolve || option === 'no-resolve';
    if (!RULE_TYPES.has(type) || !rulePayload(type, payload ?? '') || extra.length ||
      (option !== undefined && option !== 'no-resolve') ||
      (noResolve && !NO_RESOLVE_TYPES.has(type))) return null;
    return { type, payload, noResolve };
  }
  const domainSet = behavior === 'domain';
  const suffix = domainSet && entry.startsWith('+.');
  const payload = suffix ? entry.slice(2) : entry;
  const type = domainSet ? (suffix ? 'DOMAIN-SUFFIX' : 'DOMAIN') : behavior === 'ipcidr' ? cidrType(payload) : null;
  if (!type || !rulePayload(type, payload) || (domainSet && outerNoResolve)) return null;
  return { type, payload, noResolve: outerNoResolve };
}

// Stash uses Go-style regexes. Match against original node names, before any
// aliasing for the target format, with a non-backtracking engine.
function nodeFilter(value: unknown): ((name: string) => boolean) | null {
  if (value === undefined || value === '') return () => true;
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const expression = RE2JS.compile(value);
    return (name) => expression.test(name);
  } catch {
    return null;
  }
}

export function compileShadowrocket(snapshot: Snapshot, remote?: RemoteResources, validation = validateSnapshot(snapshot)): Report {
  const issues: ValidationIssue[] = [];
  const sources = new Map<string, RemoteSource>();
  let blocked = false;
  const diagnose: Diagnose = (code, message, resource, resourceId, severity = 'error') => {
    if (severity === 'error') blocked = true;
    if (issues.length < MAX_ISSUES) issues.push({ code: `shadowrocket.${code}`, message, severity, resource, resourceId });
    else if (issues.length === MAX_ISSUES) issues.push({ code: 'shadowrocket.diagnostics-limit', message: '还有其他兼容问题，请先处理上面列出的问题。', severity: 'warning' });
  };
  const hasBlockingIssue = validation.issues.some((issue) => issue.severity === 'error' &&
    !(issue.code === 'rule-provider.url-missing' && snapshot.ruleProviders.some((provider) =>
      provider.id === issue.resourceId && typeof provider.clientOptions?.shadowrocket?.sourceUrl === 'string' &&
      ['RULE-SET', 'DOMAIN-SET'].includes(String(provider.clientOptions.shadowrocket.referenceType)))));
  if (hasBlockingIssue) {
    diagnose('base', '请先修复配置检查中的错误，再生成 Shadowrocket 配置。');
    return { artifact: null, issues, sources: [] };
  }

  const general = generalLines(snapshot, diagnose);
  const native = snapshot.profile.clientOptions?.shadowrocket;
  const nativeLines = (value: unknown): value is string[] => Array.isArray(value) &&
    value.every((line) => typeof line === 'string' && !unsafeConfLine.test(line) && !line.trimStart().startsWith('['));
  if (nativeLines(native?.general)) general.push(...native.general);
  const extraSections: Array<[string, string[]]> = [];
  if (Array.isArray(native?.sections)) {
    for (const entry of native.sections) {
      if (!isJsonObject(entry) || typeof entry.name !== 'string' ||
        !/^(URL Rewrite|Header Rewrite|Body Rewrite|Script|MITM|Map Local)$/i.test(entry.name) || !nativeLines(entry.lines)) {
        diagnose('native.section', 'Shadowrocket 专用区块无效。');
      } else extraSections.push([entry.name, entry.lines]);
    }
  }
  for (const section of snapshot.advancedSections) {
    diagnose('advanced', '此高级区块可能影响运行，当前无法安全转换。', 'advanced', section.id);
  }

  const resources = [
    ...snapshot.proxies.map((item) => ({ ...item, resource: 'proxy' })),
    ...snapshot.proxyGroups.map((item) => ({ ...item, resource: 'proxy-group' }))
  ];
  const reserved = new Set([...RESERVED_POLICIES, ...resources.map((item) => item.name.toUpperCase())]);
  const names = new Map<string, string>();
  const seen = new Set<string>();
  for (const item of resources) {
    const key = item.name.toUpperCase();
    if (!policyName(item.name) || seen.has(key) || key === 'DIRECT' || key === 'REJECT') {
      diagnose('policy.name', '节点或策略组名称冲突，或含有配置分隔符。请修改名称。', item.resource, item.id);
    } else if (RESERVED_POLICIES.has(key)) {
      let alias = `Stash ${item.name}`;
      while (reserved.has(alias.toUpperCase())) alias = `Stash ${alias}`;
      reserved.add(alias.toUpperCase());
      names.set(item.name, alias);
    } else {
      names.set(item.name, item.name);
    }
    seen.add(key);
  }
  const resolve = (policy: string) => {
    if (policy === 'DIRECT' || policy === 'REJECT') return policy;
    if (policy === 'PASS' || policy === 'REJECT-DROP') return undefined;
    return names.get(policy) ?? (native?.native === true && SHADOWROCKET_BUILTINS.some((item) => item === policy) ? policy : undefined);
  };
  const proxies: string[] = [];
  for (const node of snapshot.proxies) {
    const name = names.get(node.name);
    const line = name && nodeLine(node, name);
    if (line) proxies.push(line);
    else diagnose('proxy', '此节点协议或参数无法转换。首版支持基础 Shadowsocks、HTTP 和 SOCKS5 节点。', 'proxy', node.id);
  }
  const providerNodes = new Map<number, Map<string, string>>();
  const proxyProviders = new Map(snapshot.proxyProviders.map((provider) => [provider.name, provider]));
  const sharedGroups = new Map(snapshot.proxyGroups.map(group => [group.id, splitCommonFields('policyGroup', group.config).common]));
  const sharedSources = new Map(snapshot.proxyProviders.map(source => [source.id, splitCommonFields('nodeSource', source.config).common]));
  const directNames = new Set(snapshot.proxies.map((node) => node.name));
  const groupsByName = new Map(snapshot.proxyGroups.map((group) => [group.name, group]));
  const checkedGroups = new Set<string>();
  const checkingGroups = new Set<string>();
  function cyclic(name: string): boolean {
    if (checkingGroups.has(name)) return true;
    const group = groupsByName.get(name);
    if (!group || checkedGroups.has(name)) return false;
    checkingGroups.add(name);
    const members = group.clientOptions?.shadowrocket?.nativeMembers ?? sharedGroups.get(group.id)?.policies;
    const found = Array.isArray(members) && members.some((member) => typeof member === 'string' && cyclic(member));
    checkingGroups.delete(name);
    checkedGroups.add(name);
    return found;
  }
  if (snapshot.proxyGroups.some((group) => cyclic(group.name))) {
    diagnose('group.native-cycle', 'Shadowrocket 的策略组成员中存在循环引用。');
  }
  const filters = new Map<unknown, ReturnType<typeof nodeFilter>>();
  function filterFor(value: unknown) {
    if (!filters.has(value)) {
      if (filters.size >= 128) return null;
      filters.set(value, nodeFilter(value));
    }
    return filters.get(value)!;
  }
  const groups: string[] = [];
  let remoteMemberCount = 0;
  let filterEvaluations = 0;
  groupLoop: for (const originalGroup of snapshot.proxyGroups) {
    const override = originalGroup.clientOptions?.shadowrocket;
    const explicitMembers = override?.nativeMembers;
    const group = override ? { ...originalGroup, config: { ...originalGroup.config } } : originalGroup;
    if (override) {
      const replacement = Array.isArray(explicitMembers) || typeof override['policy-regex-filter'] === 'string';
      const specific = ['ssid-policy', ...(replacement ? ['include-all', 'use-url'] : [])]
        .filter((key) => group.config[key] !== undefined);
      if (specific.length) {
        for (const key of specific) delete group.config[key];
        diagnose('group.client-options', '此策略组使用独立的 Shadowrocket 选项。', 'proxy-group', group.id, 'warning');
      }
    }
    if (group.config['include-all'] === true) {
      diagnose('group.provider', '暂不支持自动纳入全部来源。请在策略组中逐个选择要使用的代理源。', 'proxy-group', group.id);
      continue;
    }
    const shared = sharedGroups.get(group.id);
    const groupFilter = filterFor(shared?.nameFilter);
    if (!groupFilter) {
      diagnose('group.filter', '策略组筛选须使用不超过 256 字符的 RE2 正则。', 'proxy-group', group.id);
      continue;
    }
    const declared = explicitMembers ?? shared?.policies ?? [];
    if (!Array.isArray(declared)) {
      diagnose('group', '策略组成员必须是列表。', 'proxy-group', group.id);
      continue;
    }
    filterEvaluations += declared.length;
    if (filterEvaluations > MAX_FILTER_EVALUATIONS) {
      diagnose('group.filter-limit', '筛选的候选节点总数过多，请缩小策略组范围。', 'proxy-group', group.id);
      break;
    }
    // A name filter narrows nodes, not references to nested groups or built-in actions.
    const directMembers = declared
      .filter((member) => explicitMembers !== undefined || typeof member !== 'string' || !directNames.has(member) || groupFilter(member))
      .map((member) => typeof member === 'string' ? resolve(member) ?? (explicitMembers !== undefined && policyName(member) ? member : undefined) : undefined);
    const remoteMembers: string[] = [];
    const benchmarks: JsonObject[] = [];
    let unusable = false;
    for (const name of explicitMembers === undefined && Array.isArray(shared?.nodeSources) ? new Set(shared.nodeSources) : []) {
      const provider = typeof name === 'string' ? proxyProviders.get(name) : undefined;
      const filter = filterFor(provider ? sharedSources.get(provider.id)?.nameFilter : undefined);
      if (!provider || provider.sourceType !== 'remote' ||
        (provider.config.type !== undefined && provider.config.type !== 'http') ||
        !filter || !noExtra(provider.config, ['type', 'url', 'headers', 'interval', 'path', 'filter', 'benchmark-url', 'benchmark-timeout'])) {
        diagnose('group.provider', '仅支持远程 YAML 节点列表和合法的 RE2 筛选。请检查代理源类型和参数。', provider ? 'proxy-provider' : 'proxy-group', provider?.id ?? group.id);
        unusable = true;
        continue;
      }
      sources.set(`proxy-${provider.id}`, { kind: 'proxy-provider', id: provider.id, config: provider.config });
      if (!remote) {
        // Validate group options before I/O; this placeholder never reaches an artifact.
        remoteMembers.push('DIRECT');
        benchmarks.push(provider.config);
        continue;
      }
      const candidates = remote.nodes.get(provider.id) ?? [];
      filterEvaluations += candidates.length;
      if (filterEvaluations > MAX_FILTER_EVALUATIONS) {
        diagnose('group.filter-limit', '筛选的候选节点总数过多，请缩小来源和策略组范围。', 'proxy-group', group.id);
        break groupLoop;
      }
      const selected = candidates.filter((node) => filter(node.name) && groupFilter(node.name));
      if (!selected.length) continue;
      benchmarks.push(provider.config);
      let emitted = providerNodes.get(provider.id);
      if (!emitted) {
        emitted = new Map();
        providerNodes.set(provider.id, emitted);
      }
      if (remoteMembers.length + selected.length > 4_000 || remoteMemberCount + selected.length > MAX_MEMBERS) {
        diagnose('source.member-limit', '展开的远程节点超过单组或整份配置的成员数量限制。', 'proxy-group', group.id);
        unusable = true;
        break;
      }
      remoteMemberCount += selected.length;
      for (const node of selected) {
        let alias = emitted.get(node.name);
        if (!alias) {
          const label = policyName(node.name) ? node.name : '节点';
          alias = `来源 ${provider.id} · ${label}`;
          if (label !== node.name || reserved.has(alias.toUpperCase())) {
            alias += ` ${createHash('sha256').update(node.name).digest('hex').slice(0, 12)}`;
            while (reserved.has(alias.toUpperCase())) alias += ' ·';
          }
          const line = nodeLine(node, alias);
          if (!line || proxies.length >= 4_000) {
            diagnose('source.node', '所选来源包含未支持的节点协议或参数，或合并节点超过 4,000。', 'proxy-provider', provider.id);
            unusable = true;
            break;
          }
          reserved.add(alias.toUpperCase());
          emitted.set(node.name, alias);
          proxies.push(line);
        }
        remoteMembers.push(alias);
      }
    }
    if (unusable) continue;
    const config = groupBenchmark(group, benchmarks, directMembers.length > 0);
    if (!config) {
      diagnose('group.benchmark', '组内节点的测速地址或超时不一致，无法合并成 Shadowrocket 的组级设置。', 'proxy-group', group.id);
      continue;
    }
    const name = names.get(group.name);
    const line = name && groupLine({ ...group, config }, name, [...directMembers, ...remoteMembers], resolve);
    if (!line) {
      diagnose('group', '此策略组的成员、类型或参数无法转换；空组不会自动改为直连。', 'proxy-group', group.id);
      continue;
    }
    if (config.lazy === true) diagnose('group.lazy', '保留测速间隔，但 Shadowrocket 未验证支持按需测速；自动切换时机可能不同。', 'proxy-group', group.id, 'warning');
    if (group.type === 'load-balance') diagnose('group.balance', '保留负载均衡与同域名节点复用；两个客户端的哈希算法可能选到不同节点。', 'proxy-group', group.id, 'warning');
    groups.push(line);
  }

  const hosts: string[] = [];
  for (const host of snapshot.hosts) {
    if (!DOMAIN.test(host.pattern) || !isIP(host.value) || host.value.includes('%')) diagnose('host', 'Hosts 目前仅支持明确的域名到单个 IP 的映射。', 'host', host.id);
    else hosts.push(`${host.pattern} = ${host.value}`);
  }

  const providers = new Map(snapshot.ruleProviders.map((provider) => [
    provider.name, { provider, source: splitCommonFields('ruleSource', provider.config).common }
  ]));
  const rules: string[] = [];
  for (const rule of snapshot.rules.filter((item) => item.enabled).sort((a, b) => a.priority - b.priority)) {
    if (rules.length >= MAX_RULES) {
      diagnose('rule.limit', '展开后的规则超过 50,000 条，无法生成 Shadowrocket 配置。');
      break;
    }
    const policy = resolve(rule.policy);
    const { type, payload, options } = rule;
    if (!policy || options.some((option) => option !== 'no-resolve') ||
      (options.length > 0 && type !== 'RULE-SET' && !NO_RESOLVE_TYPES.has(type))) {
      diagnose('rule.policy', '此规则的策略或选项无法转换。', 'rule', rule.id);
      continue;
    }
    const suffix = options.length ? ',no-resolve' : '';
    if (type === 'MATCH') {
      rules.push(`FINAL,${policy}`);
    } else if (type === 'RULE-SET') {
      const resource = providers.get(payload);
      if (!resource) {
        diagnose('rule.provider', '找不到引用的规则集。', 'rule', rule.id);
      } else {
        const { provider, source } = resource;
        const reference = provider.clientOptions?.shadowrocket?.referenceType;
        if (reference === 'RULE-SET' || reference === 'DOMAIN-SET') {
          const alternative = provider.clientOptions?.shadowrocket?.sourceUrl;
          const value = provider.providerType === 'remote' ? alternative ?? source.address : source.filePath;
          if (provider.providerType === 'inline' || !atom(value) || (alternative === undefined && provider.headersConfigured) ||
            (provider.providerType === 'remote' ? !/^https?:\/\//i.test(value) : !/^[\p{L}\p{N}_./ -]+$/u.test(value))) {
            diagnose('rule.native-source', '原生引用必须使用有效的 HTTP/HTTPS 或本地路径，不能依赖自定义认证请求头。', 'rule-provider', provider.id);
            continue;
          }
          rules.push(`${reference},${value},${policy}${suffix}`);
          continue;
        }
        let entries: string[] | undefined;
        if (provider.providerType === 'inline') {
          entries = provider.entries.map((entry) => entry.value);
        } else if (provider.providerType === 'remote' &&
          (source.serialization === undefined || source.serialization === 'yaml' || source.serialization === 'text') &&
          (provider.config.behavior === undefined || provider.config.behavior === provider.behavior) &&
          noExtra(provider.config, ['format', 'url', 'headers', 'interval', 'path', 'behavior'])) {
          sources.set(`rule-${provider.id}`, { kind: 'rule-provider', id: provider.id, config: provider.config });
          if (!remote) continue;
          entries = remote.rules.get(provider.id);
        }
        if (!entries) {
          diagnose('rule.provider-source', '规则集须使用内联、远程 YAML 或远程文本格式。暂不支持本地文件、MRS 或其他二进制格式。', 'rule-provider', provider.id);
          continue;
        }
        for (const entry of entries) {
          if (rules.length >= MAX_RULES) {
            diagnose('rule.limit', '展开后的规则超过 50,000 条，无法生成 Shadowrocket 配置。', 'rule-provider', provider.id);
            break;
          }
          const mapped = ruleSetEntry(provider.behavior, entry, options.length > 0);
          if (!mapped) {
            diagnose('rule.provider-entry', '规则集有无法等价转换的条目或选项。', 'rule-provider', provider.id);
            break;
          }
          rules.push(`${mapped.type},${mapped.payload},${policy}${mapped.noResolve ? ',no-resolve' : ''}`);
        }
      }
    } else if (RULE_TYPES.has(type) && rulePayload(type, payload)) {
      rules.push(`${type},${payload},${policy}${suffix}`);
    } else if (native?.native === true && ((type === 'DOMAIN-WILDCARD' && /^[a-z\d.*?-]+$/i.test(payload)) ||
      (type === 'GEOIP' && payload.toUpperCase() === 'LAN'))) {
      rules.push(`${type},${payload},${policy}${suffix}`);
    } else if ((type === 'NETWORK' || type === 'PROTOCOL') && /^(tcp|udp)$/i.test(payload)) {
      rules.push(`PROTOCOL,${payload.toUpperCase()},${policy}`);
    } else if (['PROCESS-NAME', 'PROCESS-PATH'].includes(type) &&
      ['ios', 'tvos'].includes(snapshot.profile.targetPlatform)) {
      diagnose('rule.process-inactive', 'Stash 在当前目标平台已忽略这条进程规则；导出时同样不应用。', 'rule', rule.id, 'warning');
    } else if (type === 'GEOSITE') {
      diagnose('rule.geosite', 'GEOSITE 依赖客户端使用的域名数据版本及匹配类型。请用已核对内容的规则集替代。', 'rule', rule.id);
    } else if (type === 'PROTOCOL' && payload.toUpperCase() === 'MTPROTO') {
      diagnose('rule.mtproto', '此规则匹配 Stash 内置 MTProto 服务接收的连接，未找到 Shadowrocket 的等价规则。', 'rule', rule.id);
    } else if (['PROCESS-NAME', 'PROCESS-PATH'].includes(type)) {
      diagnose('rule.process', '当前目标平台可能执行进程匹配，未验证 Shadowrocket 可保留相同匹配行为。', 'rule', rule.id);
    } else {
      diagnose('rule.type', '此分流规则的类型或匹配条件无法转换。', 'rule', rule.id);
    }
  }

  if (blocked) return { artifact: null, issues, sources: [] };
  if (sources.size && !remote) return { artifact: null, issues, sources: [...sources.values()] };
  const sections = [['General', general], ['Proxy', proxies], ['Proxy Group', groups], ['Rule', rules], ['Host', hosts], ...extraSections] as const;
  const conf = sections.filter(([name, lines]) => name === 'General' || lines.length)
    .map(([name, lines]) => [`[${name}]`, ...lines].join('\n')).join('\n\n') + '\n';
  if (Buffer.byteLength(conf) > MAX_CONF_BYTES) {
    diagnose('output.limit', '生成的 Shadowrocket 配置超过 8 MiB。');
    return { artifact: null, issues, sources: [] };
  }
  return {
    issues,
    sources: [...sources.values()],
    artifact: {
      conf,
      filename: `config-${snapshot.profile.id}.conf`,
      sha256: createHash('sha256').update(conf).digest('hex'),
      ruleCount: rules.length
    }
  };
}
