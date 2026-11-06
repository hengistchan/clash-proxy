import { analyzeOrder } from './routing-analysis';
import { validateSubscriptionUrl } from './provider-source';
import { isIP } from 'node:net';

import { isLogicalRuleType, ruleSetNames } from './rules';
import type {
  JsonValue,
  Snapshot,
  ValidationIssue,
  ValidationResult
} from './types';
import {
  BUILTIN_POLICIES,
  PROXY_GROUP_TYPES,
  RULE_OPTIONS,
  RULE_TYPES,
  isJsonObject
} from './types';

const IP_RULE_TYPES = new Set([
  'IP-CIDR',
  'IP-CIDR6',
  'SRC-IP',
  'GEOIP',
  'IP-ASN'
]);
const PRE_MATCHING_RULE_TYPES = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-WILDCARD',
  'DOMAIN-REGEX',
  'GEOSITE',
  'IP-CIDR',
  'IP-CIDR6',
  'GEOIP',
  'IP-ASN',
  'DST-PORT',
  'SRC-IP',
  'SRC-PORT',
  'NETWORK',
  'RULE-SET',
  'AND',
  'OR',
  'NOT'
]);

function issue(
  issues: ValidationIssue[],
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
  resource?: string,
  resourceId?: number
): void {
  issues.push({ severity, code, message, resource, resourceId });
}

function duplicates<T>(items: T[], key: (item: T) => string): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function validCidr(payload: string): boolean {
  const [address, prefixText, extra] = payload.split('/');
  if (extra !== undefined || !address) return false;
  const version = isIP(address);
  if (!version) return false;
  if (prefixText === undefined) return true;
  if (!/^\d+$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  return prefix >= 0 && prefix <= (version === 4 ? 32 : 128);
}

function scanRuleSetReferences(
  value: JsonValue,
  references: Set<string>
): void {
  if (typeof value === 'string') {
    ruleSetNames(value).forEach((name) => references.add(name));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => scanRuleSetReferences(item, references));
    return;
  }
  if (isJsonObject(value)) {
    Object.entries(value).forEach(([key, item]) => {
      scanRuleSetReferences(key, references);
      scanRuleSetReferences(item, references);
    });
  }
}

function resolveScriptShortcuts(snapshot: Snapshot): Set<string> {
  const section = snapshot.advancedSections.find(
    (item) => item.key === 'script'
  );
  if (!section || !isJsonObject(section.value)) return new Set();
  const shortcuts = section.value.shortcuts;
  if (!isJsonObject(shortcuts)) return new Set();
  return new Set(Object.keys(shortcuts));
}

export function validateSnapshot(snapshot: Snapshot): ValidationResult {
  const issues: ValidationIssue[] = [];
  const proxyNames = new Set(snapshot.proxies.map((item) => item.name));
  const groupNames = new Set(snapshot.proxyGroups.map((item) => item.name));
  const providerNames = new Set(
    snapshot.proxyProviders.map((item) => item.name)
  );
  const ruleProviderNames = new Set(
    snapshot.ruleProviders.map((item) => item.name)
  );
  const ipRuleProviderNames = new Set(
    snapshot.ruleProviders
      .filter((item) => item.behavior === 'ipcidr')
      .map((item) => item.name)
  );
  const policyNames = new Set([
    ...BUILTIN_POLICIES,
    ...proxyNames,
    ...groupNames
  ]);

  for (const name of duplicates(
    [...snapshot.proxies, ...snapshot.proxyGroups],
    (item) => item.name
  )) {
    issue(
      issues,
      'error',
      'name.policy-duplicate',
      `Direct proxy and strategy group names must share a unique namespace: ${name}`
    );
  }
  for (const name of duplicates(snapshot.proxyProviders, (item) => item.name)) {
    issue(
      issues,
      'error',
      'name.provider-duplicate',
      `Duplicate proxy provider: ${name}`
    );
  }
  for (const name of duplicates(snapshot.ruleProviders, (item) => item.name)) {
    issue(
      issues,
      'error',
      'name.ruleset-duplicate',
      `Duplicate rule provider: ${name}`
    );
  }

  for (const proxy of snapshot.proxies) {
    if (!proxy.type) {
      issue(
        issues,
        'error',
        'proxy.type-missing',
        `Direct proxy “${proxy.name}” has no protocol type`,
        'proxy',
        proxy.id
      );
    }
  }

  for (const provider of snapshot.proxyProviders) {
    const hasUrl =
      (provider.sourceType === 'remote' && provider.sourceConfigured) ||
      (typeof provider.config.url === 'string' &&
        provider.config.url.length > 0);
    if (typeof provider.config.url === 'string') {
      try {
        validateSubscriptionUrl(provider.config.url);
      } catch {
        issue(
          issues,
          'error',
          'proxy-provider.url-invalid',
          `代理源 “${provider.name}” 的订阅地址无效，请重新配置 HTTP/HTTPS 地址。`,
          'proxy-provider',
          provider.id
        );
      }
    }
    if (
      typeof provider.config.url === 'string' &&
      provider.config.url.startsWith('http:')
    ) {
      issue(
        issues,
        'warning',
        'proxy-provider.http-source',
        `代理源 “${provider.name}” 使用明文 HTTP，设备更新订阅时地址与数据不会由 TLS 加密。`,
        'proxy-provider',
        provider.id
      );
    }
    const headers = provider.config.headers;
    if (
      headers !== undefined &&
      (!isJsonObject(headers) ||
        Object.values(headers).some(
          (value) =>
            typeof value !== 'string' &&
            !(Array.isArray(value) && value.every((v) => typeof v === 'string'))
        ))
    ) {
      issue(
        issues,
        'error',
        'proxy-provider.headers-invalid',
        `代理源 “${provider.name}” 的请求头必须是字符串或字符串数组。`,
        'proxy-provider',
        provider.id
      );
    }
    const hasPath =
      typeof provider.config.path === 'string' &&
      provider.config.path.length > 0;
    if (
      (provider.sourceType === 'remote' && !hasUrl) ||
      (provider.sourceType === 'local' && !hasPath)
    ) {
      issue(
        issues,
        'error',
        'proxy-provider.source-missing',
        `代理源 “${provider.name}” ${provider.sourceType === 'remote' ? '尚未填写订阅地址' : '尚未填写本地文件 path'}。`,
        'proxy-provider',
        provider.id
      );
    }
  }

  for (const group of snapshot.proxyGroups) {
    if (!PROXY_GROUP_TYPES.includes(group.type)) {
      issue(
        issues,
        'error',
        'group.type-invalid',
        `Strategy group “${group.name}” has unsupported type ${group.type}`,
        'proxy-group',
        group.id
      );
    }
    const proxies = Array.isArray(group.config.proxies)
      ? group.config.proxies.map(String)
      : [];
    const use = Array.isArray(group.config.use)
      ? group.config.use.map(String)
      : [];
    for (const member of proxies) {
      if (member === group.name) {
        issue(
          issues,
          'error',
          'group.self-reference',
          `Strategy group “${group.name}” cannot contain itself`,
          'proxy-group',
          group.id
        );
        continue;
      }
      if (
        !policyNames.has(member) &&
        member !== 'DIRECT' &&
        member !== 'REJECT' &&
        member !== 'REJECT-DROP'
      ) {
        issue(
          issues,
          'error',
          'group.member-missing',
          `Strategy group “${group.name}” references missing policy “${member}”`,
          'proxy-group',
          group.id
        );
      }
    }
    for (const provider of use) {
      if (!providerNames.has(provider)) {
        issue(
          issues,
          'error',
          'group.provider-missing',
          `Strategy group “${group.name}” uses missing provider “${provider}”`,
          'proxy-group',
          group.id
        );
      }
    }
    if (
      proxies.length === 0 &&
      use.length === 0 &&
      group.config['include-all'] !== true &&
      group.config['use-url'] === undefined
    ) {
      issue(
        issues,
        'warning',
        'group.empty',
        `Strategy group “${group.name}” is empty and may behave like DIRECT`,
        'proxy-group',
        group.id
      );
    }
    if (typeof group.config.filter === 'string') {
      try {
        new RegExp(group.config.filter);
      } catch {
        issue(
          issues,
          'error',
          'group.filter-invalid',
          `Strategy group “${group.name}” has an invalid filter regular expression`,
          'proxy-group',
          group.id
        );
      }
    }
    if (group.type === 'load-balance' && group.config.strategy === undefined) {
      issue(
        issues,
        'warning',
        'group.load-balance-strategy',
        `Load-balance group “${group.name}” should set strategy to consistent-hashing`,
        'proxy-group',
        group.id
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const groupMap = new Map(
    snapshot.proxyGroups.map((group) => [group.name, group])
  );
  const walk = (name: string, chain: string[]): void => {
    if (visiting.has(name)) {
      issue(
        issues,
        'error',
        'group.cycle',
        `Strategy groups contain a cycle: ${[...chain, name].join(' -> ')}`,
        'proxy-group',
        groupMap.get(name)?.id
      );
      return;
    }
    if (visited.has(name)) return;
    const group = groupMap.get(name);
    if (!group) return;
    visiting.add(name);
    const members = Array.isArray(group.config.proxies)
      ? group.config.proxies.map(String)
      : [];
    for (const member of members) {
      if (groupMap.has(member)) {
        walk(member, [...chain, name]);
      }
    }
    visiting.delete(name);
    visited.add(name);
  };
  groupMap.forEach((_group, name) => walk(name, []));

  for (const provider of snapshot.ruleProviders) {
    if (!['domain', 'ipcidr', 'classical'].includes(provider.behavior)) {
      issue(
        issues,
        'error',
        'rule-provider.behavior',
        `Rule provider “${provider.name}” has unsupported behavior ${provider.behavior}`,
        'rule-provider',
        provider.id
      );
    }
    if (
      provider.providerType === 'inline' &&
      !['domain', 'ipcidr'].includes(provider.behavior)
    ) {
      issue(
        issues,
        'error',
        'rule-provider.inline-behavior',
        `Inline rule provider “${provider.name}” must use domain or ipcidr behavior`,
        'rule-provider',
        provider.id
      );
    }
    if (provider.providerType === 'inline' && provider.entries.length === 0) {
      issue(
        issues,
        'warning',
        'rule-provider.inline-empty',
        `Inline rule provider “${provider.name}” has no entries`,
        'rule-provider',
        provider.id
      );
    }
    if (
      provider.providerType === 'remote' &&
      (typeof provider.config.url !== 'string' || !provider.config.url)
    ) {
      issue(
        issues,
        'error',
        'rule-provider.url-missing',
        `Remote rule provider “${provider.name}” needs a url`,
        'rule-provider',
        provider.id
      );
    }
    if (
      provider.providerType === 'local' &&
      (typeof provider.config.path !== 'string' || !provider.config.path)
    ) {
      issue(
        issues,
        'error',
        'rule-provider.path-missing',
        `Local rule provider “${provider.name}” needs a path`,
        'rule-provider',
        provider.id
      );
    }
  }

  const shortcuts = resolveScriptShortcuts(snapshot);
  const enabledRules = snapshot.rules.filter((rule) => rule.enabled);
  const matchRules = snapshot.rules.filter((rule) => rule.type === 'MATCH');
  if (snapshot.profile.mode === 'rule' && matchRules.length !== 1) {
    issue(
      issues,
      'error',
      'rule.match-count',
      'Configuration must contain exactly one MATCH rule',
      'rule'
    );
  }
  const finalEnabled = enabledRules.at(-1);
  if (
    snapshot.profile.mode === 'rule' &&
    (!finalEnabled || finalEnabled.type !== 'MATCH')
  ) {
    issue(
      issues,
      'error',
      'rule.match-terminal',
      'The final enabled rule must be MATCH',
      'rule'
    );
  }

  const seenRules = new Map<string, number>();
  for (const rule of snapshot.rules) {
    if (!RULE_TYPES.includes(rule.type as (typeof RULE_TYPES)[number])) {
      issue(
        issues,
        'error',
        'rule.type-invalid',
        `Rule priority ${rule.priority} has unsupported type ${rule.type}`,
        'rule',
        rule.id
      );
    }
    if (rule.type !== 'MATCH' && !rule.payload) {
      issue(
        issues,
        'error',
        'rule.payload-missing',
        `Rule priority ${rule.priority} needs a payload`,
        'rule',
        rule.id
      );
    }
    if (!policyNames.has(rule.policy)) {
      issue(
        issues,
        'error',
        'rule.policy-missing',
        `Rule priority ${rule.priority} targets missing policy “${rule.policy}”`,
        'rule',
        rule.id
      );
    }
    if (rule.type === 'RULE-SET' && !ruleProviderNames.has(rule.payload)) {
      issue(
        issues,
        'error',
        'rule.ruleset-missing',
        `Rule priority ${rule.priority} references missing rule provider “${rule.payload}”`,
        'rule',
        rule.id
      );
    }
    for (const option of rule.options) {
      if (!RULE_OPTIONS.includes(option as (typeof RULE_OPTIONS)[number])) {
        issue(
          issues,
          'error',
          'rule.option-invalid',
          `Rule priority ${rule.priority} has unsupported option “${option}”`,
          'rule',
          rule.id
        );
      }
    }
    const noResolveSupported =
      IP_RULE_TYPES.has(rule.type) ||
      (rule.type === 'RULE-SET' && ipRuleProviderNames.has(rule.payload));
    if (rule.options.includes('no-resolve') && !noResolveSupported) {
      issue(
        issues,
        'warning',
        'rule.no-resolve-unnecessary',
        `Rule priority ${rule.priority} uses no-resolve on a non-IP rule`,
        'rule',
        rule.id
      );
    }
    if (rule.options.includes('pre-matching')) {
      if (!['REJECT', 'REJECT-DROP'].includes(rule.policy)) {
        issue(
          issues,
          'error',
          'rule.pre-matching-policy',
          `Rule priority ${rule.priority} uses pre-matching without REJECT or REJECT-DROP`,
          'rule',
          rule.id
        );
      }
      if (!PRE_MATCHING_RULE_TYPES.has(rule.type)) {
        issue(
          issues,
          'error',
          'rule.pre-matching-type',
          `Rule priority ${rule.priority} cannot evaluate ${rule.type} during pre-matching`,
          'rule',
          rule.id
        );
      }
    }
    if (
      ['IP-CIDR', 'IP-CIDR6', 'SRC-IP'].includes(rule.type) &&
      !validCidr(rule.payload)
    ) {
      issue(
        issues,
        'error',
        'rule.cidr-invalid',
        `Rule priority ${rule.priority} has invalid network “${rule.payload}”`,
        'rule',
        rule.id
      );
    }
    if (rule.type === 'DST-PORT' || rule.type === 'SRC-PORT') {
      const ports = rule.payload.split('-').map(Number);
      if (
        ports.length > 2 ||
        ports.some(
          (port) => !Number.isInteger(port) || port < 1 || port > 65535
        )
      ) {
        issue(
          issues,
          'error',
          'rule.port-invalid',
          `Rule priority ${rule.priority} has invalid port range “${rule.payload}”`,
          'rule',
          rule.id
        );
      }
    }
    if (isLogicalRuleType(rule.type)) {
      let depth = 0;
      for (const char of rule.payload) {
        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
        if (depth < 0) break;
      }
      if (depth !== 0) {
        issue(
          issues,
          'error',
          'rule.logical-parentheses',
          `Rule priority ${rule.priority} has unbalanced logical-rule parentheses`,
          'rule',
          rule.id
        );
      }
    }
    if (rule.type === 'SCRIPT' && !shortcuts.has(rule.payload)) {
      issue(
        issues,
        'error',
        'rule.script-missing',
        `Rule priority ${rule.priority} references missing script shortcut “${rule.payload}”`,
        'rule',
        rule.id
      );
    }
    if (
      ['PROCESS-NAME', 'PROCESS-PATH'].includes(rule.type) &&
      rule.enabled &&
      snapshot.profile.targetPlatform !== 'macos'
    ) {
      issue(
        issues,
        ['ios', 'tvos'].includes(snapshot.profile.targetPlatform)
          ? 'warning'
          : 'info',
        'rule.process-ios',
        `第 ${rule.priority} 条进程规则在 iOS/tvOS 不生效；${snapshot.profile.targetPlatform === 'any' ? '请在全局设置中选择目标平台。' : '当前配置将保留此规则，但设备会忽略它。'}`,
        'rule',
        rule.id
      );
    }
    if (rule.enabled && rule.type !== 'MATCH') {
      const key = `${rule.type}\u0000${rule.payload}`;
      const previous = seenRules.get(key);
      if (previous) {
        issue(
          issues,
          'warning',
          'rule.shadowed',
          `Rule priority ${rule.priority} duplicates earlier rule priority ${previous}`,
          'rule',
          rule.id
        );
      } else {
        seenRules.set(key, rule.priority);
      }
    }
  }

  const dnsReferences = new Set<string>();
  scanRuleSetReferences(snapshot.profile.settings, dnsReferences);
  for (const reference of dnsReferences) {
    if (!ruleProviderNames.has(reference)) {
      issue(
        issues,
        'error',
        'dns.ruleset-missing',
        `DNS settings reference missing rule provider “${reference}”`,
        'settings'
      );
    }
  }

  for (const section of snapshot.advancedSections) {
    const references = new Set<string>();
    scanRuleSetReferences(section.value, references);
    for (const reference of references) {
      if (!ruleProviderNames.has(reference)) {
        issue(
          issues,
          'error',
          'advanced.ruleset-missing',
          `Advanced section “${section.key}” references missing rule provider “${reference}”`,
          'advanced',
          section.id
        );
      }
    }
  }

  issues.push(...analyzeOrder(snapshot));
  if (snapshot.ruleProviders.some((p) => p.providerType !== 'inline')) {
    issue(
      issues,
      'info',
      'analysis.remote-unchecked',
      '远程或本地文件规则集的内容尚未加载，无法完整分析重叠范围；结构检查通过不代表远程资源或设备业务可用。'
    );
  }
  if (
    snapshot.proxyGroups.some(
      (g) => Array.isArray(g.config.use) && g.config.use.length > 0
    )
  ) {
    issue(
      issues,
      'info',
      'group.members-unverified',
      '订阅来源中的节点未由服务抓取，策略组筛选后的成员数量和连通性需在 Stash 中确认。'
    );
  }
  return {
    valid: !issues.some((item) => item.severity === 'error'),
    issues
  };
}
