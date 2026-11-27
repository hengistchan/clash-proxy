import { posix, win32 } from 'node:path';
import { isIP } from 'node:net';
import { STASH_SECTIONS } from './client-capabilities';
import { applyTargetOverrides, assembleYamlConfig, serializeYamlConfig, yamlTargetIssues, type ExportResult } from './exporter';
import { isLogicalRuleType, splitTopLevel } from './rules';
import { validateSnapshot } from './validation';
import { publicGitHubRuleUrl } from './public-rule-mirror';
import { isJsonObject, type JsonObject, type Snapshot, type ValidationIssue } from './types';

const STASH_SECTION_SET = new Set<string>(STASH_SECTIONS);
const STASH_RULES = new Set(['SCRIPT', 'USER-AGENT', 'URL-REGEX', 'PROTOCOL']);
const INBOUND_KEYS = ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port', 'listeners'];
const GITHUB_RULE_HOST = 'raw.githubusercontent.com';
const PRIVATE_DNS_PATTERNS = new Set(['geosite:private', '*.lan', '*.local', '+.home.arpa', '+.miwifi.com']);

function httpsUrl(value: JsonObject[string]): URL | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return;
  const url = new URL(value);
  if (url.protocol === 'https:') return url;
}

function bootstrapResolvers(dns: JsonObject): string[] {
  if (!Array.isArray(dns.fallback)) return [];
  return dns.fallback.flatMap(server => {
    const url = httpsUrl(server);
    if (!url || url.hash || !isIP(url.hostname.replace(/^\[|\]$/g, ''))) return [];
    url.hash = 'DIRECT';
    return [url.href];
  });
}

function convertProviderBenchmark(source: JsonObject): boolean {
  if (!Object.hasOwn(source, 'benchmark-url') && !Object.hasOwn(source, 'benchmark-timeout')) return true;
  const legacyUrl = source['benchmark-url'];
  const legacyTimeout = source['benchmark-timeout'];
  const existing = source['health-check'];
  if (existing !== undefined && !isJsonObject(existing)) return false;
  const healthCheck = { ...existing };
  const url = healthCheck.url ?? legacyUrl ?? 'http://www.apple.com/';
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || !URL.canParse(url)) return false;
  if (healthCheck.timeout === undefined && legacyTimeout !== undefined) {
    if (typeof legacyTimeout !== 'number' || legacyTimeout <= 0 ||
        !Number.isSafeInteger(legacyTimeout * 1000) || legacyTimeout * 1000 > 0xffffffff) return false;
    healthCheck.timeout = legacyTimeout * 1000;
  }
  source['health-check'] = { ...healthCheck, url, enable: healthCheck.enable ?? true };
  delete source['benchmark-url'];
  delete source['benchmark-timeout'];
  return true;
}

// Logic rules encode conditions without a policy. Translate source IP aliases at
// each level and reject options Mihomo would otherwise silently ignore.
function mihomoCondition(type: string, payload: string, providers: Set<string>, depth = 0): [string, string] | null {
  if (STASH_RULES.has(type) || (type === 'RULE-SET' && !providers.has(payload))) return null;
  if (type === 'SRC-IP') return ['SRC-IP-CIDR', payload];
  if (!isLogicalRuleType(type)) return [type, payload];
  if (depth >= 32 || !payload.startsWith('(') || !payload.endsWith(')')) return null;
  const parts = splitTopLevel(payload.slice(1, -1));
  if (type === 'NOT' && parts.length !== 1) return null;
  const conditions: string[] = [];
  for (const part of parts) {
    if (!part.startsWith('(') || !part.endsWith(')')) return null;
    const [childType, childPayload, ...options] = splitTopLevel(part.slice(1, -1));
    if (!childType || !childPayload || ['MATCH', 'SUB-RULE'].includes(childType) ||
        options.some(option => option !== 'no-resolve')) return null;
    const converted = mihomoCondition(childType, childPayload, providers, depth + 1);
    if (!converted) return null;
    conditions.push(`(${[...converted, ...options].join(',')})`);
  }
  return [type, `(${conditions.join(',')})`];
}

function convertStashMultiRegex(pattern: string): string {
  const parts = pattern.split('`').filter((part) => part.length > 0);
  if (parts.length <= 1) return parts[0] ?? pattern;
  return parts.map((part) => `(?:${part})`).join('|');
}

export function compileMihomo(snapshot: Snapshot, checked?: ExportResult['validation']): { artifact: ExportResult | null; issues: ValidationIssue[] } {
  const enabled = snapshot.rules.filter(rule => rule.enabled);
  const omitted = snapshot.advancedSections.filter(section => STASH_SECTION_SET.has(section.key));
  const warnings: ValidationIssue[] = [];
  const omittedSsidGroups: string[] = [];
  const omittedBenchmarkDisabledGroups: string[] = [];
  const downgradedSmartGroups: string[] = [];
  const compatible = {
    ...snapshot,
    rules: enabled,
    proxyGroups: snapshot.proxyGroups.map(group => {
      let changed = false;
      let nextType = group.type;
      const nextConfig = { ...group.config };
      if (Object.hasOwn(nextConfig, 'ssid-policy')) {
        omittedSsidGroups.push(group.name);
        delete nextConfig['ssid-policy'];
        changed = true;
      }
      if (Object.hasOwn(nextConfig, 'benchmark-disabled')) {
        omittedBenchmarkDisabledGroups.push(group.name);
        delete nextConfig['benchmark-disabled'];
        changed = true;
      }
      if (nextType === 'smart') {
        nextType = 'url-test';
        downgradedSmartGroups.push(group.name);
        delete nextConfig['policy-priority'];
        if (nextConfig.interval === undefined) nextConfig.interval = 300;
        if (nextConfig.tolerance === undefined) nextConfig.tolerance = 50;
        changed = true;
      } else if (Object.hasOwn(nextConfig, 'policy-priority')) {
        delete nextConfig['policy-priority'];
        changed = true;
      }
      if (typeof nextConfig.filter === 'string' && nextConfig.filter.includes('`')) {
        nextConfig.filter = convertStashMultiRegex(nextConfig.filter);
        changed = true;
      }
      if (typeof nextConfig['exclude-filter'] === 'string' && nextConfig['exclude-filter'].includes('`')) {
        nextConfig['exclude-filter'] = convertStashMultiRegex(nextConfig['exclude-filter']);
        changed = true;
      }
      return changed ? { ...group, type: nextType, config: nextConfig } : group;
    }),
    advancedSections: snapshot.advancedSections.filter(section => !STASH_SECTION_SET.has(section.key))
  };
  const validation = checked && enabled.length === snapshot.rules.length ? checked : validateSnapshot({ ...snapshot, rules: enabled });
  const issues = [...validation.issues.filter(issue => issue.severity === 'error'), ...yamlTargetIssues(compatible, 'mihomo')];
  const error = (code: string, message: string, resource: string, resourceId?: number) => {
    issues.push({ severity: 'error', code: `mihomo.${code}`, message, resource, resourceId });
  };
  const blocked = () => ({ artifact: null, issues: issues.slice(0, 100) });

  const providerNames = new Set(snapshot.ruleProviders.map(provider => provider.name));
  compatible.rules = enabled.map(rule => {
    const condition = mihomoCondition(rule.type, rule.payload, providerNames);
    if (!condition || rule.options.some(option => option !== 'no-resolve')) {
      error('rule', `第 ${rule.priority} 条规则的类型、引用、逻辑条件或选项无法转换为 Mihomo，请先调整规则。`, 'rule', rule.id);
      return rule;
    }
    const [type, payload] = condition;
    return { ...rule, type, payload };
  });
  for (const group of compatible.proxyGroups) {
    if (group.type === 'relay') {
      error('relay', 'Mihomo 已移除 relay 策略组；请用节点的 dialer-proxy 表达链路。', 'proxy-group', group.id);
    }
    if (['use-url', 'dialer-proxy', 'interface-name', 'routing-mark'].some(key => Object.hasOwn(group.config, key))) {
      error('group-option', '此策略组含 Mihomo 不支持的组设置（use-url、dialer-proxy、interface-name 或 routing-mark）。', 'proxy-group', group.id);
    }
    if (![group.config.proxies, group.config.use].some(value => Array.isArray(value) && value.length > 0) &&
        !['include-all', 'include-all-proxies', 'include-all-providers'].some(key => group.config[key] === true)) {
      error('empty-group', '请为此策略组添加节点或代理源。', 'proxy-group', group.id);
    }
  }
  if (issues.length) return blocked();

  const { config, proxyRewrites } = assembleYamlConfig(compatible, 'mihomo');
  applyTargetOverrides(config, 'mihomo', snapshot.profile.clientOptions);
  const managedSources = new Map(proxyRewrites?.sources.map(source => [source.id, source]));
  const seenPaths = new Set<string>();

  function configureProvider(source: JsonObject, type: 'http' | 'file' | 'inline', resource: string, id: number) {
    source.type = type;
    if (typeof source.path === 'string' && source.path) {
      const portablePath = source.path.replaceAll('\\', '/');
      const normalized = posix.normalize(portablePath);
      if (posix.isAbsolute(portablePath) || win32.isAbsolute(source.path) || normalized === '..' || normalized.startsWith('../') || normalized === '.') {
        error('provider-path', '请将来源路径设为 Mihomo 工作目录下的相对文件路径。', resource, id);
      } else if (seenPaths.has(normalized)) {
        error('provider-path-conflict', '多个来源使用了同一个文件路径，请分别设置路径。', resource, id);
      }
      seenPaths.add(normalized);
    }
    if (isJsonObject(source.headers)) {
      if (Object.hasOwn(source, 'header')) {
        error('provider-header-conflict', '来源同时设置了 header 和 headers，请只保留其中一项。', resource, id);
      } else {
        source.header = Object.fromEntries(Object.entries(source.headers).map(([name, value]) =>
          [name, typeof value === 'string' ? [value] : value]
        ));
      }
      delete source.headers;
    }
  }

  const proxies = config['proxy-providers'] as Record<string, JsonObject> | undefined;
  for (const provider of snapshot.proxyProviders) {
    const source = proxies![provider.name];
    configureProvider(source, provider.sourceType === 'inline' ? 'inline' : provider.sourceType === 'remote' ? 'http' : 'file', 'proxy-provider', provider.id);
    if (!convertProviderBenchmark(source)) {
      error('provider-benchmark', '代理源的测速设置无法转换为 Mihomo。请检查 HTTP(S) 测速地址、超时秒数和 health-check 格式。', 'proxy-provider', provider.id);
    }
    const managed = managedSources.get(provider.id);
    if (managed) {
      if (Object.hasOwn(provider.config, 'header')) {
        error('managed-source-header', '改写代理源使用工作台保存的请求头，请在代理源表单中配置请求头。', 'proxy-provider', provider.id);
      }
      // The shared delivery pipeline replaces the placeholder with a target-specific capability.
      delete source.header;
    }
  }
  const ruleProviders = config['rule-providers'] as Record<string, JsonObject>;
  const publicRules: NonNullable<ExportResult['publicRules']> = [];
  let directGitHubRuleProvider = false;
  for (const provider of snapshot.ruleProviders) {
    const type = provider.providerType === 'remote' ? 'http' : provider.providerType === 'local' ? 'file' : 'inline';
    const source = ruleProviders[provider.name];
    configureProvider(source, type, 'rule-provider', provider.id);
    if (type === 'http' && httpsUrl(source.url)?.hostname === GITHUB_RULE_HOST && source.proxy === undefined) {
      source.proxy = 'DIRECT';
      const upstream = publicGitHubRuleUrl(source.url);
      if (upstream && !Object.hasOwn(source, 'header') && !Object.hasOwn(source, 'headers') &&
          (source.format === undefined || source.format === 'yaml' || source.format === 'text')) {
        publicRules.push({ name: provider.name, upstream: upstream.href });
      } else {
        directGitHubRuleProvider = true;
      }
    }
  }

  const dns = isJsonObject(config.dns) ? { ...config.dns } : {};
  const resolvers = bootstrapResolvers(dns);
  if (publicRules.length && dns.enable !== false && resolvers.length) {
    for (const key of ['nameserver', 'proxy-server-nameserver']) {
      const configured = dns[key];
      if (Array.isArray(configured) && configured.length && configured.every(server => typeof server === 'string' && isIP(server))) {
        dns[key] = [...configured, ...resolvers];
      }
    }
  }
  if (directGitHubRuleProvider && dns.enable !== false && dns['nameserver-policy'] === undefined &&
      dns['direct-nameserver'] === undefined) {
    if (resolvers.length) dns['nameserver-policy'] = { [GITHUB_RULE_HOST]: resolvers };
  }
  if (Object.hasOwn(dns, 'follow-rule')) {
    if (typeof dns['follow-rule'] !== 'boolean' || (dns['respect-rules'] !== undefined && dns['respect-rules'] !== dns['follow-rule'])) {
      error('dns-follow-rule', 'DNS 的 follow-rule 和 respect-rules 设置无效或冲突。', 'settings');
    } else {
      dns['respect-rules'] = dns['follow-rule'];
    }
    delete dns['follow-rule'];
  }
  if (dns['respect-rules'] === true &&
      (!Array.isArray(dns['proxy-server-nameserver']) || !dns['proxy-server-nameserver'].length)) {
    error('dns-resolver', '启用 DNS 分流时，请为 Mihomo 配置 proxy-server-nameserver，以独立解析代理节点域名。', 'settings');
  }
  if (Object.keys(dns).length && dns.enable === undefined) dns.enable = true;
  if (isJsonObject(dns['nameserver-policy'])) {
    const looped = Object.entries(dns['nameserver-policy']).filter(([pattern, resolver]) => {
      if (!PRIVATE_DNS_PATTERNS.has(pattern.toLowerCase())) return false;
      const list = Array.isArray(resolver) ? resolver.map(String) : [String(resolver)];
      return list.some(item => item.trim().toLowerCase() === 'system');
    }).map(([pattern]) => pattern);
    if (looped.length) {
      warnings.push({
        severity: 'warning',
        code: 'mihomo.dns-private-system',
        message: `Mihomo 的 DNS 策略中 ${looped.join('、')} 指向 system；在 Clash Verge TUN 接管系统 DNS 为 127.0.0.1 时可能触发 5 秒自环超时，建议在 Mihomo 专属覆盖中改用 dhcp://en0 或路由器 IP。`,
        resource: 'settings'
      });
    }
  }
  config.dns = dns;
  if (!INBOUND_KEYS.some(key => Object.hasOwn(config, key)) && !(isJsonObject(config.tun) && config.tun.enable === true)) {
    config['mixed-port'] = 7890;
  }
  if (issues.length) return blocked();

  const comments = ['Clash configuration for Mihomo'];
  if (omitted.length) {
    comments.push(`未迁移的 Stash 专用区块：${omitted.map(section => section.key).join('、')}`);
    warnings.push({
      severity: 'warning',
      code: 'mihomo.omitted-sections',
      message: `未迁移的 Stash 专用区块：${omitted.map(section => section.key).join('、')}`
    });
  }
  if (downgradedSmartGroups.length) {
    comments.push(`已将 Stash smart 策略组降级为 Mihomo url-test：${downgradedSmartGroups.join('、')}`);
    warnings.push({
      severity: 'warning',
      code: 'mihomo.smart-downgraded',
      message: `标准 Mihomo 内核不支持 smart 策略组，已自动降级为 url-test 并移除 policy-priority：${downgradedSmartGroups.join('、')}`
    });
  }
  if (omittedSsidGroups.length) {
    comments.push(`已省略 Mihomo 不支持的 ssid-policy 策略组：${omittedSsidGroups.join('、')}`);
    warnings.push({
      severity: 'warning',
      code: 'mihomo.omitted-group-options',
      message: `已省略策略组中的 ssid-policy（Mihomo 不支持）：${omittedSsidGroups.join('、')}`
    });
  }
  if (omittedBenchmarkDisabledGroups.length) {
    comments.push(`已省略 Mihomo 不支持的 benchmark-disabled 策略组：${omittedBenchmarkDisabledGroups.join('、')}`);
    warnings.push({
      severity: 'warning',
      code: 'mihomo.omitted-group-options',
      message: `已省略策略组中的 benchmark-disabled（Mihomo 不支持）：${omittedBenchmarkDisabledGroups.join('、')}`
    });
  }
  return {
    artifact: {
      ...serializeYamlConfig(config, `mihomo-${snapshot.profile.id}.yaml`, validation, comments),
      ...(proxyRewrites ? { proxyRewrites } : {}),
      ...(publicRules.length ? { publicRules } : {})
    },
    issues: warnings
  };
}
