import { RE2JS } from 're2js';
import { stringify } from 'yaml';
import { HttpError } from './http';
import { proxyRewriteRulesSchema } from './schemas';
import { readRemoteNodes } from './remote-proxy-nodes';
import type { JsonObject, ProxyRewriteRule } from './types';

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
  const examples: Array<{ node: number; field: ProxyRewriteRule['field']; before: boolean | 'missing' | 'other'; after: boolean }> = [];
  const fields = [...new Set(compiled.map(({ field }) => field))];
  const proxies = nodes.map((node, index) => {
    const config: JsonObject = { ...node.config };
    for (const rule of compiled) {
      if ((rule.protocol && rule.protocol !== node.type) || (rule.matcher && !rule.matcher.test(node.name))) continue;
      matched.add(index);
      const present = Object.hasOwn(config, rule.field);
      const previous = config[rule.field];
      if ((present && rule.operation === 'fill') || previous === rule.value) continue;
      config[rule.field] = rule.value;
    }
    for (const field of fields) {
      if (config[field] === node.config[field]) continue;
      changed.add(index);
      const before = node.config[field];
      if (examples.length < 15) examples.push({
        node: index + 1, field,
        before: !Object.hasOwn(node.config, field) ? 'missing' : typeof before === 'boolean' ? before : 'other',
        after: config[field] as boolean
      });
    }
    return { name: node.name, type: node.type, ...config };
  });
  return {
    yaml: stringify({ proxies }, { lineWidth: 0 }),
    preview: { totalNodes: nodes.length, matchedNodes: matched.size, changedNodes: changed.size, examples }
  };
}
