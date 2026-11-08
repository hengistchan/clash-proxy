import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { BUILTIN_POLICIES, isJsonObject, type JsonObject, type Snapshot, type ValidationIssue } from './types';
import { validateSnapshot } from './validation';
import type { RemoteResources, RemoteSource } from './shadowrocket-sources';

export const SHADOWROCKET_COMPILER_VERSION = 1;
const MAX_RULES = 50_000;
const MAX_MEMBERS = 50_000;
const MAX_CONF_BYTES = 8 * 1024 * 1024;
const MAX_ISSUES = 100;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;
const RESERVED_POLICIES = new Set([...BUILTIN_POLICIES, 'PROXY', 'REJECT-TINYGIF', 'REJECT-DICT', 'REJECT-ARRAY', 'REJECT-200', 'REJECT-IMG', 'REJECT-NO-DROP']);
const RULE_TYPES = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'GEOIP']);
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
    if (!noExtra(config, [...common, 'cipher', 'password', 'udp']) ||
      !cipher || !atom(password) || /\s/.test(password)) return null;
    parts.push(`encrypt-method=${cipher}`, `password=${password}`);
    if (udp !== undefined) parts.push(`udp-relay=${udp}`);
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

function groupLine(group: Snapshot['proxyGroups'][number], name: string, resolve: (value: string) => string | undefined, remoteMembers: string[]) {
  const { type, config } = group;
  if (!['select', 'url-test', 'fallback'].includes(type)) return null;
  const manual = type === 'select';
  const fields = ['proxies', 'use', 'hidden', 'icon', ...(manual ? [] : ['interval', 'tolerance', 'url', 'benchmark-url', 'benchmark-timeout'])];
  if (!noExtra(config, fields) || (config.use !== undefined && !Array.isArray(config.use)) ||
    (config.hidden !== undefined && typeof config.hidden !== 'boolean')) return null;
  const members = config.proxies ?? [];
  if (!Array.isArray(members)) return null;
  const policies = [...members.map((member) => typeof member === 'string' ? resolve(member) : undefined), ...remoteMembers];
  if (!policies.length || policies.some((policy) => policy === undefined)) return null;
  const fieldsOut = [type, ...policies];
  if (config.hidden === true) fieldsOut.push('hidden=1');
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
  if (!isJsonObject(dns) || !noExtra(dns, ['nameserver'])) {
    diagnose('dns', '自定义 DNS 策略无法等价转换。目前仅支持基础 nameserver。', 'dns');
    return lines;
  }
  const nameservers = dns.nameserver;
  if (nameservers === undefined) return lines;
  if (!Array.isArray(nameservers) || !nameservers.length || !nameservers.every((value) => atom(value) && ((isIP(value) !== 0 && !value.includes('%')) || (httpUrl(value) && value.startsWith('https://'))))) {
    diagnose('dns.nameserver', 'DNS 服务器仅支持 IP 地址或 HTTPS DNS 地址。', 'dns');
  } else {
    lines.push(`dns-server = ${nameservers.join(', ')}`);
    diagnose('dns.runtime', '已转换 DNS 服务器地址。Shadowrocket 的 DNS 解析路径由客户端决定，请在设备上验证。', 'dns', undefined, 'warning');
  }
  return lines;
}

function ruleSetEntry(behavior: string, entry: string, outerNoResolve: boolean) {
  if (behavior === 'classical') {
    const [type, payload, option, ...extra] = entry.split(',').map((part) => part.trim());
    const noResolve = outerNoResolve || option === 'no-resolve';
    if (!RULE_TYPES.has(type) || !rulePayload(type, payload ?? '') || extra.length ||
      (option !== undefined && option !== 'no-resolve') ||
      (noResolve && !['IP-CIDR', 'IP-CIDR6', 'GEOIP'].includes(type))) return null;
    return { type, payload, noResolve };
  }
  const domainSet = behavior === 'domain';
  const suffix = domainSet && entry.startsWith('+.');
  const payload = suffix ? entry.slice(2) : entry;
  const type = domainSet ? (suffix ? 'DOMAIN-SUFFIX' : 'DOMAIN') : behavior === 'ipcidr' ? cidrType(payload) : null;
  if (!type || !rulePayload(type, payload) || (domainSet && outerNoResolve)) return null;
  return { type, payload, noResolve: outerNoResolve };
}

// A bounded subset of Stash's source filter syntax. No repetitions or nested
// expressions are executed on the server.
function providerFilter(value: unknown): ((name: string) => boolean) | null {
  if (value === undefined || value === '') return () => true;
  if (typeof value !== 'string' || value.length > 256) return null;
  const ignoreCase = value.startsWith('(?i)');
  const patterns = (ignoreCase ? value.slice(4) : value).split('|');
  if (patterns.length > 16 || !patterns.every((pattern) => /^\^?[\p{L}\p{N} _-]+\$?$/u.test(pattern))) return null;
  const expression = new RegExp(patterns.join('|'), ignoreCase ? 'iu' : 'u');
  return (name) => expression.test(name);
}

export function compileShadowrocket(snapshot: Snapshot, remote?: RemoteResources): Report {
  const issues: ValidationIssue[] = [];
  const sources = new Map<string, RemoteSource>();
  let blocked = false;
  const diagnose: Diagnose = (code, message, resource, resourceId, severity = 'error') => {
    if (severity === 'error') blocked = true;
    if (issues.length < MAX_ISSUES) issues.push({ code: `shadowrocket.${code}`, message, severity, resource, resourceId });
    else if (issues.length === MAX_ISSUES) issues.push({ code: 'shadowrocket.diagnostics-limit', message: '还有其他兼容问题，请先处理上面列出的问题。', severity: 'warning' });
  };
  if (!validateSnapshot(snapshot).valid) {
    diagnose('base', '请先修复配置检查中的错误，再生成 Shadowrocket 配置。');
    return { artifact: null, issues, sources: [] };
  }

  const general = generalLines(snapshot, diagnose);
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
    return names.get(policy);
  };
  const proxies: string[] = [];
  for (const node of snapshot.proxies) {
    const name = names.get(node.name);
    const line = name && nodeLine(node, name);
    if (line) proxies.push(line);
    else diagnose('proxy', '此节点协议或参数无法转换。首版支持基础 Shadowsocks、HTTP 和 SOCKS5 节点。', 'proxy', node.id);
  }
  const providerNodes = new Map<number, string[]>();
  const proxyProviders = new Map(snapshot.proxyProviders.map((provider) => [provider.name, provider]));
  const groups: string[] = [];
  let remoteMemberCount = 0;
  for (const group of snapshot.proxyGroups) {
    if (group.config['include-all'] === true) {
      diagnose('group.provider', '暂不支持自动纳入全部来源。请在策略组中逐个选择要使用的代理源。', 'proxy-group', group.id);
      continue;
    }
    const remoteMembers: string[] = [];
    for (const name of Array.isArray(group.config.use) ? new Set(group.config.use) : []) {
      const provider = typeof name === 'string' ? proxyProviders.get(name) : undefined;
      const filter = providerFilter(provider?.config.filter);
      if (!provider || provider.sourceType !== 'remote' ||
        (provider.config.type !== undefined && provider.config.type !== 'http') ||
        !filter || !noExtra(provider.config, ['type', 'url', 'headers', 'interval', 'path', 'filter'])) {
        diagnose('group.provider', '代理源须为远程 YAML 节点列表。筛选仅支持文字关键词、竖线、首尾匹配及 (?i)。', provider ? 'proxy-provider' : 'proxy-group', provider?.id ?? group.id);
        continue;
      }
      sources.set(`proxy-${provider.id}`, { kind: 'proxy-provider', id: provider.id, config: provider.config });
      if (!remote) {
        // Validate group options before doing any network I/O. This placeholder cannot reach an artifact.
        remoteMembers.push('DIRECT');
        continue;
      }
      if (!providerNodes.has(provider.id)) {
        const members: string[] = [];
        for (const node of remote.nodes.get(provider.id) ?? []) {
          if (!filter(node.name)) continue;
          const label = policyName(node.name) ? node.name : '节点';
          let alias = `来源 ${provider.id} · ${label}`;
          if (label !== node.name || reserved.has(alias.toUpperCase())) {
            const hash = createHash('sha256').update(node.name).digest('hex').slice(0, 12);
            alias += ` ${hash}`;
            while (reserved.has(alias.toUpperCase())) alias += ' ·';
          }
          reserved.add(alias.toUpperCase());
          const line = nodeLine(node, alias);
          if (!line) {
            diagnose('source.node', '远程代理源包含无法转换的节点协议或参数。', 'proxy-provider', provider.id);
            break;
          }
          if (proxies.length >= 4_000) {
            diagnose('source.node-limit', '合并后的节点数量超过 4,000。', 'proxy-provider', provider.id);
            break;
          }
          proxies.push(line);
          members.push(alias);
        }
        providerNodes.set(provider.id, members);
      }
      const members = providerNodes.get(provider.id)!;
      if (!members.length) diagnose('source.node-empty', '远程代理源没有可用节点。', 'proxy-provider', provider.id);
      if (remoteMembers.length + members.length > 4_000) {
        diagnose('source.member-limit', '单个策略组展开后最多支持 4,000 个远程节点。', 'proxy-group', group.id);
        break;
      }
      remoteMemberCount += members.length;
      if (remoteMemberCount > MAX_MEMBERS) {
        diagnose('source.member-limit', '所有策略组展开后的远程成员总数超过 50,000。');
        break;
      }
      remoteMembers.push(...members);
    }
    const name = names.get(group.name);
    const line = name && groupLine(group, name, resolve, remoteMembers);
    if (line) groups.push(line);
    else diagnose('group', '此策略组的类型、成员或参数无法转换。首版支持非空的手动选择、自动测速和故障转移组。', 'proxy-group', group.id);
  }

  const hosts: string[] = [];
  for (const host of snapshot.hosts) {
    if (!DOMAIN.test(host.pattern) || !isIP(host.value) || host.value.includes('%')) diagnose('host', 'Hosts 目前仅支持明确的域名到单个 IP 的映射。', 'host', host.id);
    else hosts.push(`${host.pattern} = ${host.value}`);
  }

  const providers = new Map(snapshot.ruleProviders.map((provider) => [provider.name, provider]));
  const rules: string[] = [];
  for (const rule of snapshot.rules.filter((item) => item.enabled).sort((a, b) => a.priority - b.priority)) {
    if (rules.length >= MAX_RULES) {
      diagnose('rule.limit', '展开后的规则超过 50,000 条，无法生成 Shadowrocket 配置。');
      break;
    }
    const policy = resolve(rule.policy);
    const { type, payload, options } = rule;
    if (!policy || options.some((option) => option !== 'no-resolve') ||
      (options.length > 0 && !['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'RULE-SET'].includes(type))) {
      diagnose('rule.policy', '此规则的策略或选项无法转换。', 'rule', rule.id);
      continue;
    }
    const suffix = options.length ? ',no-resolve' : '';
    if (type === 'MATCH') {
      rules.push(`FINAL,${policy}`);
    } else if (type === 'RULE-SET') {
      const provider = providers.get(payload);
      if (!provider) {
        diagnose('rule.provider', '找不到引用的规则集。', 'rule', rule.id);
      } else {
        let entries: string[] | undefined;
        if (provider.providerType === 'inline') {
          entries = provider.entries.map((entry) => entry.value);
        } else if (provider.providerType === 'remote' &&
          (provider.config.format === undefined || provider.config.format === 'yaml' || provider.config.format === 'text') &&
          noExtra(provider.config, ['format', 'url', 'headers', 'interval', 'path'])) {
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
    } else {
      diagnose('rule.type', '此分流规则的类型或匹配条件无法转换。', 'rule', rule.id);
    }
  }

  if (blocked) return { artifact: null, issues, sources: [] };
  if (sources.size && !remote) return { artifact: null, issues, sources: [...sources.values()] };
  const sections = [['General', general], ['Proxy', proxies], ['Proxy Group', groups], ['Rule', rules], ['Host', hosts]] as const;
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
