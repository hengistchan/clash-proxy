import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { HttpError } from './http';
import { ruleListToYaml } from './rules';
import type { ClientOptions, JsonObject, JsonValue, ProxyRewriteRule, Snapshot, YamlClientTarget } from './types';
import { RESERVED_TOP_LEVEL_KEYS, isJsonObject } from './types';
import { validateSnapshot } from './validation';
import { exportRuleProvider } from './rule-provider-source';
import { CONFIG_COMPILER_VERSION } from './artifact-semantics';
import { SHADOWROCKET_BUILTINS } from './types';
import type { ValidationIssue } from './types';

export function stashTargetIssues(snapshot: Snapshot): ValidationIssue[] {
  return yamlTargetIssues(snapshot, 'stash');
}

export function yamlTargetIssues(snapshot: Snapshot, target: 'stash' | 'mihomo'): ValidationIssue[] {
  const label = target === 'stash' ? 'Stash' : 'Mihomo';
  const inlineIssues: ValidationIssue[] = target === 'stash' ? snapshot.proxyProviders.filter(provider => provider.sourceType === 'inline').map(provider => ({
    severity: 'error', code: 'stash.inline-proxy-source', message: '内联代理源使用 Mihomo 格式；请将节点移到直接节点，或改用远程／本地代理源后交付给 Stash。', resource: 'proxy-provider', resourceId: provider.id
  })) : [];
  if (target === 'stash') inlineIssues.push(...snapshot.ruleProviders.filter(provider => provider.providerType === 'inline' && provider.behavior === 'classical').map(provider => ({ severity: 'error' as const, code: 'rule-provider.inline-behavior', message: 'Stash 内联规则集支持 domain 和 ipcidr；classical 请改为远程或本地规则集。', resource: 'rule-provider', resourceId: provider.id })));
  if (snapshot.profile.clientOptions?.shadowrocket?.native !== true) return inlineIssues;
  const options = snapshot.profile.clientOptions.shadowrocket;
  const issues: ValidationIssue[] = [...inlineIssues];
  const add = (message: string, resource?: string, resourceId?: number) => issues.push({
    severity: 'error', code: `${target}.shadowrocket-native`, message, resource, resourceId
  });
  const known = new Set([...snapshot.proxies, ...snapshot.proxyGroups].map((item) => item.name));
  const nativePolicy = (name: string) => !known.has(name) && SHADOWROCKET_BUILTINS.some((item) => item === name);
  if ([options.general, options.sections].some((items) => Array.isArray(items) && items.length > 0)) {
    add(`导入的配置包含 Shadowrocket 专用全局设置或区块；为保留行为，不能直接交付给 ${label}。`);
  }
  for (const group of snapshot.proxyGroups) {
    const native = group.clientOptions?.shadowrocket;
    const members = Array.isArray(group.config.proxies) ? group.config.proxies : [];
    if (native && (native.use === true || Array.isArray(native.nativeMembers) ||
      (!members.length && native['policy-regex-filter'] !== undefined))) {
      add(`此策略组依赖 Shadowrocket 客户端节点，无法转换为 ${label}。`, 'proxy-group', group.id);
    }
  }
  for (const rule of snapshot.rules.filter((item) => item.enabled)) {
    if (nativePolicy(rule.policy)) add('此规则依赖 Shadowrocket 内置策略。', 'rule', rule.id);
  }
  const used = new Set(snapshot.rules.filter((rule) => rule.enabled && rule.type === 'RULE-SET').map((rule) => rule.payload));
  for (const source of snapshot.ruleProviders) {
    if (used.has(source.name) && source.clientOptions?.shadowrocket?.referenceType === 'DOMAIN-SET') {
      add(`Shadowrocket DOMAIN-SET 的匹配格式不能自动作为 ${label} 规则集发布。`, 'rule-provider', source.id);
    }
  }
  return issues;
}

const KNOWN_EARLY_SECTIONS = ['http', 'cron', 'script-providers', 'script'];
export interface ExportResult {
  compilerVersion?: number;
  yaml: string;
  filename: string;
  sha256: string;
  ruleCount: number;
  validation: ReturnType<typeof validateSnapshot>;
  proxyRewrites?: { profileId: number; sources: ManagedProxySource[] };
  publicRules?: Array<{ name: string; upstream: string }>;
}

export interface ManagedProxySource {
  id: number;
  name: string;
  upstream: JsonObject;
  rules: ProxyRewriteRule[];
}

function mergeObject(
  base: JsonObject,
  additions: Record<string, unknown>
): JsonObject {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(additions).filter(([, value]) => value !== undefined)
    )
  } as JsonObject;
}

export function applyTargetOverrides(
  config: Record<string, unknown>,
  target: YamlClientTarget,
  clientOptions?: ClientOptions
): void {
  const overrides = clientOptions?.[target];
  if (!isJsonObject(overrides)) return;
  if (isJsonObject(overrides.dns)) {
    const dns: Record<string, unknown> = isJsonObject(config.dns) ? { ...config.dns } : {};
    for (const [key, value] of Object.entries(overrides.dns)) {
      if (value === null) {
        delete dns[key];
      } else if (key === 'nameserver-policy' && isJsonObject(value) && isJsonObject(dns['nameserver-policy'])) {
        const policy: Record<string, unknown> = { ...dns['nameserver-policy'] };
        for (const [pattern, resolver] of Object.entries(value)) {
          if (resolver === null) delete policy[pattern];
          else policy[pattern] = resolver;
        }
        dns['nameserver-policy'] = policy;
      } else {
        dns[key] = value;
      }
    }
    config.dns = dns;
  }
  if (isJsonObject(overrides.sections)) {
    for (const [key, value] of Object.entries(overrides.sections)) {
      if (RESERVED_TOP_LEVEL_KEYS.has(key)) continue;
      if (value === null) delete config[key];
      else config[key] = value;
    }
  }
}

export function buildConfigObject(snapshot: Snapshot, validation = validateSnapshot(snapshot)) {
  const nativeIssues = stashTargetIssues(snapshot);
  if (nativeIssues.length) throw new HttpError(409, 'Stash compatibility check failed', nativeIssues);
  if (!validation.valid) {
    throw new HttpError(
      409,
      'Configuration validation failed',
      validation.issues.filter((item) => item.severity === 'error')
    );
  }

  const assembled = assembleYamlConfig(snapshot, 'stash');
  applyTargetOverrides(assembled.config, 'stash', snapshot.profile.clientOptions);
  return { ...assembled, validation };
}

export function assembleYamlConfig(snapshot: Snapshot, target?: YamlClientTarget) {
  const advanced = new Map(
    snapshot.advancedSections.map((item) => [item.key, item.value])
  );
  const config: Record<string, unknown> = {};
  config.mode = snapshot.profile.mode;
  config['log-level'] = snapshot.profile.logLevel;
  if (snapshot.profile.ipv6 !== null) {
    config.ipv6 = snapshot.profile.ipv6;
  }

  for (const key of KNOWN_EARLY_SECTIONS) {
    if (advanced.has(key)) {
      config[key] = advanced.get(key);
      advanced.delete(key);
    }
  }

  if (snapshot.hosts.length) {
    config.hosts = Object.fromEntries(
      snapshot.hosts.map((item) => [item.pattern, item.value])
    );
  }

  config.dns = isJsonObject(snapshot.profile.settings.dns)
    ? snapshot.profile.settings.dns
    : {};

  if (snapshot.proxies.length) {
    config.proxies = snapshot.proxies.map((item) =>
      mergeObject(item.config, { name: item.name, type: item.type })
    );
  }

  const groups = snapshot.proxyGroups.map((item) =>
    mergeObject(item.config, { name: item.name, type: item.type })
  );
  if (groups.length) config['proxy-groups'] = groups;

  const sources: ManagedProxySource[] = [];
  const providers = Object.fromEntries(
    snapshot.proxyProviders.map((item) => {
      const provider = { ...item.config };
      const effectiveRules = item.rewriteRules?.filter((rule) =>
        !target || !rule.targets?.length || rule.targets.includes(target)
      );
      if (item.sourceType === 'remote' && effectiveRules?.length && typeof provider.url === 'string') {
        const { url, headers } = provider;
        sources.push({ id: item.id, name: item.name, upstream: { url, ...(headers !== undefined ? { headers } : {}) }, rules: effectiveRules });
        provider.url = 'https://managed-source.invalid/proxies.yaml';
        delete provider.headers;
      }
      return [item.name, provider];
    })
  );
  if (Object.keys(providers).length) config['proxy-providers'] = providers;

  const ruleProviders = Object.fromEntries(
    snapshot.ruleProviders.map((item) => [item.name, exportRuleProvider(item)])
  );
  config['rule-providers'] = ruleProviders;

  config.rules = ruleListToYaml(snapshot.rules);

  for (const [key, value] of advanced) {
    config[key] = value;
  }

  return { config, ...(sources.length ? { proxyRewrites: { profileId: snapshot.profile.id, sources } } : {}) };
}

export function exportProfile(snapshot: Snapshot, checked?: ExportResult['validation']): ExportResult {
  const { config, validation, proxyRewrites } = buildConfigObject(snapshot, checked);
  return {
    ...serializeYamlConfig(config, `config-${snapshot.profile.id}.yaml`, validation),
    compilerVersion: CONFIG_COMPILER_VERSION,
    ...(proxyRewrites ? { proxyRewrites } : {})
  };
}

export function serializeYamlConfig(
  config: Record<string, unknown>,
  filename: string,
  validation: ExportResult['validation'],
  comments: string[] = []
): ExportResult {
  const yaml = comments.map(line => `# ${line}\n`).join('') + stringifyYaml(config, {
    lineWidth: 0,
    minContentWidth: 0,
    sortMapEntries: false
  });

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    throw new HttpError(500, 'Generated configuration could not be parsed');
  }
  if (!isJsonObject(parsed)) {
    throw new HttpError(500, 'Generated configuration is not a YAML mapping');
  }
  const expectedRules = config.rules as string[];
  if (JSON.stringify(parsed.rules) !== JSON.stringify(expectedRules)) {
    throw new HttpError(500, 'Generated rule verification failed');
  }
  const sha256 = createHash('sha256').update(yaml, 'utf8').digest('hex');
  return {
    yaml,
    filename,
    sha256,
    ruleCount: expectedRules.length,
    validation
  };
}

export function reservedTopLevelKey(key: string): boolean {
  return RESERVED_TOP_LEVEL_KEYS.has(key);
}

export function stringifyJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}
