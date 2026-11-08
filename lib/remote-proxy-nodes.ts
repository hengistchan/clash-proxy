import { parseDocument } from 'yaml';
import { isJsonObject, type ProxyNode } from './types';

const MAX_NODES = 2_000;

export function readRemoteYamlMapping(text: string) {
  const doc = parseDocument(text, { strict: true, uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error('Invalid YAML');
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!isJsonObject(value)) throw new Error('Expected a YAML mapping');
  return value;
}

export function readRemoteNodes(text: string, sourceId: number): ProxyNode[] {
  const { proxies } = readRemoteYamlMapping(text);
  if (!Array.isArray(proxies) || !proxies.length || proxies.length > MAX_NODES) throw new Error('Invalid proxy list');
  const seen = new Set<string>();
  return proxies.map((item, index) => {
    if (!isJsonObject(item)) throw new Error('Invalid proxy');
    const { name, type, ...config } = item;
    if (typeof name !== 'string' || !name.trim() || name.length > 160 || seen.has(name) ||
      typeof type !== 'string' || !type) throw new Error('Invalid proxy');
    seen.add(name);
    return { id: sourceId, name, type, config, sortOrder: index + 1 };
  });
}
