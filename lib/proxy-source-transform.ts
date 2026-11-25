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

function compileOptionalRegex(pattern: unknown): { regex: RE2JS | null; invalid: boolean } {
  if (typeof pattern !== 'string' || !pattern) return { regex: null, invalid: false };
  try {
    return { regex: RE2JS.compile(pattern), invalid: false };
  } catch {
    return { regex: null, invalid: true };
  }
}

export function analyzeProxyGroupCoverage(
  nodeNames: string[],
  proxyGroups: ProxyGroup[],
  providerName?: string
): ProxyGroupCoverage {
  const relevant = proxyGroups.filter((group) => {
    const uses = Array.isArray(group.config.use) ? group.config.use.map(String) : [];
    const includeAll = group.config['include-all'] === true || group.config['include-all-providers'] === true;
    return includeAll || (providerName ? uses.includes(providerName) : uses.length > 0);
  });
  const coveredByAuto = new Set<string>();
  const groups: ProxyGroupCoverageEntry[] = relevant.map((group) => {
    const inc = compileOptionalRegex(group.config.filter);
    const exc = compileOptionalRegex(group.config['exclude-filter']);
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
    const matched = nodeNames.filter((name) =>
      (!inc.regex || inc.regex.test(name)) && (!exc.regex || !exc.regex.test(name))
    );
    if (['url-test', 'fallback', 'load-balance'].includes(group.type)) {
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
  const uncovered = relevant.some((group) => ['url-test', 'fallback', 'load-balance'].includes(group.type))
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
    preview: { totalNodes: nodes.length, matchedNodes: matched.size, changedNodes: changed.size, examples }
  };
}
