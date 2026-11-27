import { RE2JS } from 're2js';
import { stringify } from 'yaml';
import { HttpError } from './http';
import { proxyRewriteRulesSchema } from './schemas';
import { readRemoteNodes } from './remote-proxy-nodes';
import type { JsonObject, ProxyGroup, ProxyRewriteRule, ProxyRewriteValue } from './types';

const MAX_TRANSFORMED_BYTES = 8 * 1024 * 1024;

export interface ProxyGroupCoverageEntry {
  id: number;
  name: string;
  type: ProxyGroup['type'];
  filter: string | null;
  excludeFilter: string | null;
  matchedCount: number;
  sampleNames: string[];
  invalidRegex?: boolean;
}

export interface ProxyGroupCoverage {
  groups: ProxyGroupCoverageEntry[];
  uncoveredAutoCount: number;
  uncoveredAutoSamples: string[];
}

const AUTO_GROUP_TYPES = new Set<ProxyGroup['type']>(['smart', 'url-test', 'fallback', 'load-balance']);

const PROTOCOL_ALIASES: Record<string, string> = {
  ss: 'shadowsocks',
  ssr: 'shadowsocksr',
  hy2: 'hysteria2',
  wg: 'wireguard'
};

function canonicalProtocolName(value: string): string {
  const lower = value.trim().toLowerCase();
  return PROTOCOL_ALIASES[lower] ?? lower;
}

function compileOptionalRegex(pattern: unknown): { regexes: RE2JS[]; invalid: boolean } {
  if (typeof pattern !== 'string' || !pattern) return { regexes: [], invalid: false };
  const regexes: RE2JS[] = [];
  for (const segment of pattern.split('`')) {
    if (!segment) continue;
    try {
      regexes.push(RE2JS.compile(segment));
    } catch {
      return { regexes: [], invalid: true };
    }
  }
  return { regexes, invalid: false };
}

function matchesAny(regexes: RE2JS[], value: string): boolean {
  return regexes.some((regex) => regex.test(value));
}

export function analyzeProxyGroupCoverage(
  nodesInput: Array<string | { name: string; type?: string }>,
  proxyGroups: ProxyGroup[],
  providerName?: string
): ProxyGroupCoverage {
  const nodes = nodesInput.map((item) => (typeof item === 'string' ? { name: item } : item));
  const nodeNames = nodes.map((item) => item.name);
  const relevant = proxyGroups.filter((group) => {
    const uses = Array.isArray(group.config.use) ? group.config.use.map(String) : [];
    const includeAll = group.config['include-all'] === true || group.config['include-all-providers'] === true;
    return includeAll || (providerName ? uses.includes(providerName) : uses.length > 0);
  });
  const coveredByAuto = new Set<string>();
  const groups: ProxyGroupCoverageEntry[] = relevant.map((group) => {
    const inc = compileOptionalRegex(group.config.filter);
    const exc = compileOptionalRegex(group.config['exclude-filter']);
    const excludedTypes =
      typeof group.config['exclude-type'] === 'string' && group.config['exclude-type'].trim()
        ? new Set(
            group.config['exclude-type']
              .split('|')
              .map((item) => item.trim().toLowerCase())
              .filter(Boolean)
          )
        : null;
    if (inc.invalid || exc.invalid) {
      return {
        id: group.id,
        name: group.name,
        type: group.type,
        filter: typeof group.config.filter === 'string' ? group.config.filter : null,
        excludeFilter: typeof group.config['exclude-filter'] === 'string' ? group.config['exclude-filter'] : null,
        matchedCount: 0,
        sampleNames: [],
        invalidRegex: true
      };
    }
    const matched = nodes
      .filter((node) => {
        if (inc.regexes.length && !matchesAny(inc.regexes, node.name)) return false;
        if (exc.regexes.length && matchesAny(exc.regexes, node.name)) return false;
        if (excludedTypes && node.type) {
          const lower = node.type.toLowerCase();
          if (excludedTypes.has(lower) || excludedTypes.has(canonicalProtocolName(lower))) return false;
        }
        return true;
      })
      .map((node) => node.name);
    if (AUTO_GROUP_TYPES.has(group.type)) {
      for (const name of matched) coveredByAuto.add(name);
    }
    return {
      id: group.id,
      name: group.name,
      type: group.type,
      filter: typeof group.config.filter === 'string' ? group.config.filter : null,
      excludeFilter: typeof group.config['exclude-filter'] === 'string' ? group.config['exclude-filter'] : null,
      matchedCount: matched.length,
      sampleNames: matched.slice(0, 6)
    };
  });
  const uncovered = relevant.some((group) => AUTO_GROUP_TYPES.has(group.type))
    ? nodeNames.filter((name) => !coveredByAuto.has(name))
    : [];
  return {
    groups,
    uncoveredAutoCount: uncovered.length,
    uncoveredAutoSamples: uncovered.slice(0, 10)
  };
}

export function validateProxyRewrites(rules: ProxyRewriteRule[]) {
  const normalized = proxyRewriteRulesSchema.parse(rules);
  return normalized.map((rule, index) => {
    try {
      return { ...rule, matcher: rule.matchName ? RE2JS.compile(rule.matchName) : null };
    } catch {
      throw new HttpError(400, `第 ${index + 1} 条代理源改写规则的节点名称正则无效。`);
    }
  });
}

export function transformProxySource(text: string, rules: ProxyRewriteRule[]) {
  const compiled = validateProxyRewrites(rules);
  const nodes = readRemoteNodes(text, 0);
  const matched = new Set<number>();
  const changed = new Set<number>();
  const examples: Array<{ node: number; field: string; before: boolean | 'missing' | 'other'; after: ProxyRewriteValue }> = [];
  const fields = [...new Set(compiled.map(({ field }) => field))];
  let addedBytes = 0;
  const proxies = nodes.map((node, index) => {
    const config: JsonObject = { ...node.config };
    for (const rule of compiled) {
      if ((rule.protocol && rule.protocol !== node.type) || (rule.matcher && !rule.matcher.test(node.name))) continue;
      matched.add(index);
      const present = Object.hasOwn(config, rule.field);
      if (present && (rule.operation === 'fill' || config[rule.field] === rule.value)) continue;
      config[rule.field] = rule.value;
    }
    for (const field of fields) {
      const after = Object.hasOwn(config, field) ? config[field] : undefined;
      const before = Object.hasOwn(node.config, field) ? node.config[field] : undefined;
      if (after === before || (typeof after !== 'string' && typeof after !== 'number' && typeof after !== 'boolean')) continue;
      // Bound expansion before YAML serialization, especially when one string applies to every node.
      addedBytes += Buffer.byteLength(field) + Buffer.byteLength(JSON.stringify(after)) + 8;
      if (addedBytes > MAX_TRANSFORMED_BYTES) throw new Error('Transformed proxy list is too large');
      changed.add(index);
      if (examples.length < 15) examples.push({
        node: index + 1, field,
        before: !Object.hasOwn(node.config, field) ? 'missing' : typeof before === 'boolean' ? before : 'other',
        after
      });
    }
    return { name: node.name, type: node.type, ...config };
  });
  const yaml = stringify({ proxies }, { lineWidth: 0 });
  if (Buffer.byteLength(yaml) > MAX_TRANSFORMED_BYTES) throw new Error('Transformed proxy list is too large');
  return {
    yaml,
    nodeNames: nodes.map((node) => node.name),
    nodes: nodes.map((node) => ({ name: node.name, type: node.type })),
    preview: { totalNodes: nodes.length, matchedNodes: matched.size, changedNodes: changed.size, examples }
  };
}
