import { RE2JS } from 're2js';
import { stringify } from 'yaml';
import { HttpError } from './http';
import { proxyRewriteRulesSchema } from './schemas';
import { readRemoteNodes } from './remote-proxy-nodes';
import type { JsonObject, ProxyRewriteRule, ProxyRewriteValue } from './types';

const MAX_TRANSFORMED_BYTES = 8 * 1024 * 1024;

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
    preview: { totalNodes: nodes.length, matchedNodes: matched.size, changedNodes: changed.size, examples }
  };
}
