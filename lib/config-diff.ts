import type { JsonValue, Snapshot } from './types';

export interface ConfigChange {
  resource: string;
  label: string;
  change: 'added' | 'removed' | 'changed';
  fields: string[];
}

export interface ConfigDiff {
  added: number;
  removed: number;
  changed: number;
  orderChanged: string[];
  changes: ConfigChange[];
  truncated: boolean;
  totalChanges: number;
}

const MAX_CHANGES = 500;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

// Resource identifiers are visible in ordinary lists, but an imported identifier
// may itself be a credential URL. Never echo such an identifier in a diff.
export function safeChangeLabel(value: string): string {
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(value) || /(?:token|pass(?:word)?|authorization|api[-_]?key|secret)\s*[:=]/i.test(value)) {
    return '包含敏感信息的资源标识（已隐藏）';
  }
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
}

interface Comparable {
  key: string;
  label: string;
  values: Record<string, unknown>;
}

function named(items: Array<{ name: string } & Record<string, unknown>>, fields: string[]): Comparable[] {
  return items.map((item) => ({
    key: item.name,
    label: safeChangeLabel(item.name),
    values: Object.fromEntries(fields.map((key) => [key, item[key]]))
  }));
}

const FIELD_LABELS: Record<string, string> = {
  rewriteRules: '代理源改写规则', clientOptions: '客户端专用参数', type: '类型', config: '配置参数', source: '私人来源或认证信息', members: '成员与顺序', sources: '关联代理源', filter: '筛选条件', displayName: '显示名称', behavior: '匹配格式',
  providerType: '来源类型', entries: '规则条目', payload: '匹配条件', policy: '目标策略',
  options: '规则选项', enabled: '启用状态', note: '备注', value: '内容', mode: '运行模式',
  targetPlatform: '设备平台', logLevel: '日志级别', ipv6: 'IPv6', settings: 'DNS与全局参数'
};

function rules(snapshot: Snapshot): Comparable[] {
  const occurrences = new Map<string, number>();
  return snapshot.rules.map((rule, index) => {
    const identity = `${rule.type}\u0000${rule.payload}`;
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    return {
      key: `${identity}\u0000${occurrence}`,
      label: `规则 ${index + 1} · ${safeChangeLabel(rule.type)}`,
      values: { policy: rule.policy, options: rule.options, enabled: rule.enabled, note: rule.note }
    };
  });
}

/** A semantic summary only: no original or replacement field values leave here. */
export function compareConfigurations(before: Snapshot, after: Snapshot): ConfigDiff {
  const result: ConfigDiff = { added: 0, removed: 0, changed: 0, orderChanged: [], changes: [], truncated: false, totalChanges: 0 };
  const add = (change: ConfigChange) => {
    result[change.change]++;
    result.totalChanges++;
    if (result.changes.length < MAX_CHANGES) result.changes.push(change);
    else result.truncated = true;
  };
  const compare = (resource: string, left: Comparable[], right: Comparable[], ordered = false) => {
    const oldItems = new Map(left.map((item) => [item.key, item]));
    const newItems = new Map(right.map((item) => [item.key, item]));
    for (const item of left) if (!newItems.has(item.key)) add({ resource, label: item.label, change: 'removed', fields: [] });
    for (const item of right) {
      const old = oldItems.get(item.key);
      if (!old) add({ resource, label: item.label, change: 'added', fields: [] });
      else {
        const changed = Object.keys(item.values).filter((field) => canonical(old.values[field]) !== canonical(item.values[field]));
        if (changed.length) add({ resource, label: item.label, change: 'changed', fields: changed.map((field) => FIELD_LABELS[field] || '参数') });
      }
    }
    if (ordered) {
      const oldOrder = left.filter((item) => newItems.has(item.key)).map((item) => item.key);
      const newOrder = right.filter((item) => oldItems.has(item.key)).map((item) => item.key);
      if (canonical(oldOrder) !== canonical(newOrder)) result.orderChanged.push(resource);
    }
  };
  compare('全局与 DNS', [{ key: 'profile', label: '全局与 DNS', values: profileValues(before) }], [{ key: 'profile', label: '全局与 DNS', values: profileValues(after) }]);
  compare('直接节点', named(before.proxies as unknown as Parameters<typeof named>[0], ['type', 'config']), named(after.proxies as unknown as Parameters<typeof named>[0], ['type', 'config']), true);
  const withSource = <T extends { name: string; config: Record<string, unknown> }>(items: T[]) => items.map((item): { name: string } & Record<string, unknown> => ({
    ...item,
    source: { url: item.config.url, headers: item.config.headers },
    config: Object.fromEntries(Object.entries(item.config).filter(([key]) => key !== 'url' && key !== 'headers'))
  }));
  compare('代理源', named(withSource(before.proxyProviders), ['config', 'source', 'rewriteRules']), named(withSource(after.proxyProviders), ['config', 'source', 'rewriteRules']), true);
  const groups = (snapshot: Snapshot) => snapshot.proxyGroups.map((item) => ({
    ...item, members: item.config.proxies, sources: item.config.use, filter: item.config.filter,
    config: Object.fromEntries(Object.entries(item.config).filter(([key]) => !['proxies', 'use', 'filter'].includes(key)))
  }));
  compare('策略组', named(groups(before), ['type', 'members', 'sources', 'filter', 'config', 'clientOptions']), named(groups(after), ['type', 'members', 'sources', 'filter', 'config', 'clientOptions']), true);
  const providers = (snapshot: Snapshot) => snapshot.ruleProviders.map((item) => ({ ...item, entries: item.entries.map((entry) => entry.value) }));
  compare('规则集', named(withSource(providers(before)), ['displayName', 'behavior', 'providerType', 'config', 'source', 'entries', 'clientOptions']), named(withSource(providers(after)), ['displayName', 'behavior', 'providerType', 'config', 'source', 'entries', 'clientOptions']), true);
  compare('路由规则', rules(before), rules(after), true);
  const hosts = (snapshot: Snapshot) => snapshot.hosts.map((item) => ({ key: item.pattern, label: safeChangeLabel(item.pattern), values: { value: item.value } }));
  compare('Hosts', hosts(before), hosts(after));
  const advanced = (snapshot: Snapshot) => snapshot.advancedSections.map((item) => ({ key: item.key, label: safeChangeLabel(item.key), values: { value: item.value } }));
  compare('高级区块', advanced(before), advanced(after));
  return result;
}

function profileValues(snapshot: Snapshot): Record<string, JsonValue | undefined> {
  const profile = snapshot.profile;
  return { mode: profile.mode, targetPlatform: profile.targetPlatform, logLevel: profile.logLevel, ipv6: profile.ipv6, settings: profile.settings, clientOptions: profile.clientOptions };
}
