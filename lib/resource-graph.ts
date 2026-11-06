import {
  BUILTIN_POLICIES,
  isJsonObject,
  type JsonValue,
  type ResourceKind,
  type Snapshot
} from './types';
import { ruleSetNames } from './references';

export type GraphKind =
  | ResourceKind
  | 'settings'
  | 'advanced'
  | 'builtin'
  | 'missing';
export interface ResourceNode {
  key: string;
  kind: GraphKind;
  id: number;
  name: string;
  label: string;
  description: string;
}
export interface ResourceEdge {
  from: string;
  to: string;
  label: string;
}
export interface ResourceGraph {
  nodes: ResourceNode[];
  edges: ResourceEdge[];
}
export const resourceKey = (kind: GraphKind, id: number | string) =>
  `${kind}:${id}`;

export function buildResourceGraph(snapshot: Snapshot): ResourceGraph {
  const nodes: ResourceNode[] = [],
    edges: ResourceEdge[] = [];
  const policy = new Map<string, string>(),
    sources = new Map<string, string>(),
    sets = new Map<string, string>();
  const add = (
    kind: GraphKind,
    item: { id: number; name: string },
    description: string,
    label = item.name
  ) => {
    const key = resourceKey(kind, item.id);
    nodes.push({ id: item.id, name: item.name, key, kind, label, description });
    return key;
  };
  for (const [id, name] of BUILTIN_POLICIES.entries())
    policy.set(name, add('builtin', { id, name }, 'Stash 内置出口'));
  for (const p of snapshot.proxyProviders)
    sources.set(
      p.name,
      add(
        'proxy-providers',
        p,
        p.sourceConfigured ? '订阅来源已配置' : '订阅来源待配置'
      )
    );
  for (const p of snapshot.proxies)
    policy.set(p.name, add('proxies', p, `直接节点 · ${p.type}`));
  for (const g of snapshot.proxyGroups)
    policy.set(g.name, add('proxy-groups', g, `策略组 · ${g.type}`));
  for (const p of snapshot.ruleProviders)
    sets.set(
      p.name,
      add(
        'rule-providers',
        p,
        `${p.providerType} · ${p.behavior}`,
        p.displayName || p.name
      )
    );
  const missing = (name: string, expected: string) => {
    const key = resourceKey('missing', `${expected}:${name}`);
    if (!nodes.some((n) => n.key === key))
      nodes.push({
        key,
        kind: 'missing',
        id: 0,
        name,
        label: name,
        description: `缺少${expected}`
      });
    return key;
  };
  const link = (from: string, to: string, label: string) => {
    if (!edges.some((e) => e.from === from && e.to === to && e.label === label))
      edges.push({ from, to, label });
  };
  for (const group of snapshot.proxyGroups) {
    const from = resourceKey('proxy-groups', group.id);
    if (Array.isArray(group.config.proxies))
      for (const name of group.config.proxies.map(String))
        link(from, policy.get(name) || missing(name, '策略或节点'), '出口成员');
    if (Array.isArray(group.config.use))
      for (const name of group.config.use.map(String))
        link(from, sources.get(name) || missing(name, '代理源'), '使用订阅');
    if (group.config['include-all'] === true) {
      for (const key of sources.values()) link(from, key, '包含全部来源');
      for (const node of snapshot.proxies)
        link(from, resourceKey('proxies', node.id), '包含全部节点');
    }
    if (isJsonObject(group.config['ssid-policy']))
      for (const [network, name] of Object.entries(
        group.config['ssid-policy']
      )) {
        if (typeof name === 'string')
          link(
            from,
            policy.get(name) || missing(name, '网络策略'),
            `网络切换 · ${network}`
          );
      }
  }
  for (const rule of snapshot.rules) {
    const from = add(
      'rules',
      { id: rule.id, name: `#${rule.priority} ${rule.type}` },
      `${rule.enabled ? '已启用' : '已停用'} · ${rule.payload || '最终兜底'}`
    );
    link(
      from,
      policy.get(rule.policy) || missing(rule.policy, '出口策略'),
      '流量交给'
    );
    if (rule.type === 'RULE-SET')
      link(
        from,
        sets.get(rule.payload) || missing(rule.payload, '规则集'),
        '匹配规则集'
      );
    // Logical expressions can contain RULE-SET references; do not infer semantic relationships from domain contents.
    if (['AND', 'OR', 'NOT'].includes(rule.type))
      for (const match of rule.payload.matchAll(/RULE-SET,([^,)]+)/g))
        link(
          from,
          sets.get(match[1]) || missing(match[1], '规则集'),
          '逻辑条件引用'
        );
  }
  const settings = add(
    'settings',
    { id: 0, name: '全局与 DNS' },
    '域名解析与运行设置'
  );
  const scan = (from: string, value: JsonValue) => {
    if (typeof value === 'string')
      for (const name of ruleSetNames(value))
        link(from, sets.get(name) || missing(name, '规则集'), 'DNS / 扩展引用');
    else if (Array.isArray(value)) value.forEach((v) => scan(from, v));
    else if (isJsonObject(value))
      for (const [key, item] of Object.entries(value)) {
        scan(from, key);
        scan(from, item);
        if (key === 'dialer-proxy' && typeof item === 'string')
          link(
            from,
            policy.get(item) || missing(item, '代理链出口'),
            '代理链出口'
          );
      }
  };
  scan(settings, snapshot.profile.settings);
  for (const section of snapshot.advancedSections) {
    const key = add(
      'advanced',
      { id: section.id, name: section.key },
      '扩展配置区块'
    );
    scan(key, section.value);
  }
  const scripts = snapshot.advancedSections.find(
    (s) => s.key === 'script-providers'
  );
  for (const section of snapshot.advancedSections.filter((s) =>
    ['http', 'cron'].includes(s.key)
  )) {
    if (!isJsonObject(section.value) || !Array.isArray(section.value.script))
      continue;
    for (const item of section.value.script)
      if (isJsonObject(item) && typeof item.name === 'string') {
        const exists =
          scripts &&
          isJsonObject(scripts.value) &&
          Object.prototype.hasOwnProperty.call(scripts.value, item.name);
        link(
          resourceKey('advanced', section.id),
          exists
            ? resourceKey('advanced', scripts.id)
            : missing(item.name, '脚本来源'),
          `使用脚本 · ${item.name}`
        );
      }
  }
  for (const node of snapshot.proxies)
    scan(resourceKey('proxies', node.id), node.config);
  return { nodes, edges };
}
