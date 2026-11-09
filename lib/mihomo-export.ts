import { posix, win32 } from 'node:path';
import { assembleYamlConfig, serializeYamlConfig, yamlTargetIssues, type ExportResult } from './exporter';
import { isLogicalRuleType, splitTopLevel } from './rules';
import { validateSnapshot } from './validation';
import { isJsonObject, type JsonObject, type Snapshot, type ValidationIssue } from './types';

const STASH_SECTIONS = ['http', 'cron', 'script', 'script-providers'];
const STASH_RULES = new Set(['SCRIPT', 'USER-AGENT', 'URL-REGEX', 'PROTOCOL']);
const INBOUND_KEYS = ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port', 'listeners'];

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

export function compileMihomo(snapshot: Snapshot): { artifact: ExportResult | null; issues: ValidationIssue[] } {
  const enabled = snapshot.rules.filter(rule => rule.enabled);
  const omitted = snapshot.advancedSections.filter(section => STASH_SECTIONS.includes(section.key));
  const compatible = {
    ...snapshot,
    rules: enabled,
    advancedSections: snapshot.advancedSections.filter(section => !STASH_SECTIONS.includes(section.key))
  };
  const validation = validateSnapshot({ ...snapshot, rules: enabled });
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
  for (const group of snapshot.proxyGroups) {
    if (group.type === 'relay') {
      error('relay', 'Mihomo 已移除 relay 策略组；请用节点的 dialer-proxy 表达链路。', 'proxy-group', group.id);
    }
    if (['use-url', 'ssid-policy', 'dialer-proxy', 'interface-name', 'routing-mark'].some(key => Object.hasOwn(group.config, key))) {
      error('group-option', '此策略组含 Mihomo 不支持的组设置（use-url、ssid-policy、dialer-proxy、interface-name 或 routing-mark）。', 'proxy-group', group.id);
    }
    if (![group.config.proxies, group.config.use].some(value => Array.isArray(value) && value.length > 0) &&
        !['include-all', 'include-all-proxies', 'include-all-providers'].some(key => group.config[key] === true)) {
      error('empty-group', '请为此策略组添加节点或代理源。', 'proxy-group', group.id);
    }
  }
  if (issues.length) return blocked();

  const { config, proxyRewrites } = assembleYamlConfig(compatible);
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
    configureProvider(source, provider.sourceType === 'remote' ? 'http' : 'file', 'proxy-provider', provider.id);
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
  for (const provider of snapshot.ruleProviders) {
    const type = provider.providerType === 'remote' ? 'http' : provider.providerType === 'local' ? 'file' : 'inline';
    configureProvider(ruleProviders[provider.name], type, 'rule-provider', provider.id);
  }

  const dns = isJsonObject(config.dns) ? { ...config.dns } : {};
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
  config.dns = dns;
  if (!INBOUND_KEYS.some(key => Object.hasOwn(config, key)) && !(isJsonObject(config.tun) && config.tun.enable === true)) {
    config['mixed-port'] = 7890;
  }
  if (issues.length) return blocked();

  const comments = ['Clash configuration for Mihomo'];
  if (omitted.length) comments.push(`未迁移的 Stash 专用区块：${omitted.map(section => section.key).join('、')}`);
  return {
    artifact: {
      ...serializeYamlConfig(config, `mihomo-${snapshot.profile.id}.yaml`, validation, comments),
      ...(proxyRewrites ? { proxyRewrites } : {})
    },
    issues: omitted.length ? [{
      severity: 'warning',
      code: 'mihomo.omitted-sections',
      message: `未迁移的 Stash 专用区块：${omitted.map(section => section.key).join('、')}`
    }] : []
  };
}
