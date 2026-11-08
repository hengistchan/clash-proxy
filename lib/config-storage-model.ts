import { decryptJson, encryptJson } from './crypto';
import { isJsonObject, type ClientOptions, type JsonObject, type JsonValue, type ProxyRewriteRule, type Snapshot } from './types';

export type StoredResourceKind = 'settings' | 'node' | 'nodeSource' | 'policyGroup' | 'ruleSource' | 'extension';
const PREFIX = 'model1:';

// The current management API uses Stash-compatible keys. Only deliberately
// shared semantics are projected into the core; unknown or dialect-specific
// fields stay namespaced and retain their original types and spelling.
const sourceKeys = {
  url: 'address', headers: 'requestHeaders', path: 'filePath', interval: 'refreshSeconds'
} as const;
const fields = {
  settings: {},
  dns: { nameserver: 'resolvers', 'proxy-server-nameserver': 'proxyHostResolvers' },
  node: {
    server: 'host', port: 'port', username: 'username', password: 'password',
    cipher: 'cipher', udp: 'supportsUdp'
  },
  nodeSource: { ...sourceKeys, filter: 'nameFilter' },
  policyGroup: {
    proxies: 'policies', use: 'nodeSources', filter: 'nameFilter', hidden: 'hidden',
    interval: 'probeIntervalSeconds', tolerance: 'switchToleranceMilliseconds',
    url: 'probeUrl', 'benchmark-url': 'benchmarkUrl', 'benchmark-timeout': 'probeTimeoutSeconds',
    strategy: 'balanceStrategy'
  },
  ruleSource: { ...sourceKeys, format: 'serialization' }
} satisfies Record<Exclude<StoredResourceKind, 'extension'> | 'dns', Record<string, string>>;

function separate(value: JsonObject, mapping: Record<string, string>) {
  const common: [string, JsonValue][] = [];
  const extensions: [string, JsonValue][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(mapping, key)) common.push([mapping[key], item]);
    else extensions.push([key, item]);
  }
  return { common: Object.fromEntries(common), extensions: { stash: Object.fromEntries(extensions) } };
}

type ModelKind = keyof typeof fields;
type CommonKey<K extends ModelKind> = (typeof fields)[K][keyof (typeof fields)[K]] & string;

/** Shared semantics used by storage and compilers. The compatibility DTO keeps
 * client spellings at its boundary; adapters work with these names internally. */
export function splitCommonFields<K extends ModelKind>(kind: K, value: JsonObject) {
  const { common, extensions } = separate(value, fields[kind]);
  return { common: common as Partial<Record<CommonKey<K>, JsonValue>>, stash: extensions.stash };
}

function combine(value: JsonValue, mapping: Record<string, string>): JsonObject {
  if (!isJsonObject(value) || !isJsonObject(value.common) || !isJsonObject(value.extensions) ||
    !isJsonObject(value.extensions.stash)) throw new Error('Invalid configuration storage model');
  return {
    ...value.extensions.stash,
    ...Object.fromEntries(Object.entries(mapping).flatMap(([key, field]) =>
      Object.hasOwn(value.common as JsonObject, field) ? [[key, (value.common as JsonObject)[field]]] : []
    ))
  };
}

export function storeResource(kind: StoredResourceKind, value: JsonValue, options?: ClientOptions): JsonValue {
  if (kind === 'extension') return { extensions: { stash: value } };
  if (!isJsonObject(value)) throw new Error('Expected a configuration mapping');
  const result = separate(value, fields[kind]);
  if (kind === 'settings' && isJsonObject(value.dns)) {
    delete result.extensions.stash.dns;
    result.common.dns = separate(value.dns, fields.dns);
  }
  return options?.shadowrocket && Object.keys(options.shadowrocket).length
    ? { ...result, extensions: { ...result.extensions, shadowrocket: options.shadowrocket } }
    : result;
}

function projectResource(kind: StoredResourceKind, stored: JsonValue): JsonValue {
  if (kind === 'extension') {
    if (!isJsonObject(stored) || !isJsonObject(stored.extensions) ||
      !Object.hasOwn(stored.extensions, 'stash')) throw new Error('Invalid configuration extension');
    return stored.extensions.stash;
  }
  const projected = combine(stored, fields[kind]);
  if (kind === 'settings' && isJsonObject(stored) && isJsonObject(stored.common) &&
    Object.hasOwn(stored.common, 'dns')) projected.dns = combine(stored.common.dns, fields.dns);
  return projected;
}

export function encryptResource(kind: StoredResourceKind, value: JsonValue, options?: ClientOptions) {
  return PREFIX + encryptJson(storeResource(kind, value, options));
}

function storedNodeSource(value: JsonObject, rules: ProxyRewriteRule[] | undefined): JsonObject {
  const stored = storeResource('nodeSource', value) as JsonObject;
  if (rules?.length && isJsonObject(stored.common)) stored.common.nodeTransforms = rules.map((rule) => ({ ...rule }));
  return stored;
}

function projectRewriteRules(value: JsonValue): ProxyRewriteRule[] | undefined {
  if (isJsonObject(value) && isJsonObject(value.common) && Array.isArray(value.common.nodeTransforms)) {
    return value.common.nodeTransforms as unknown as ProxyRewriteRule[];
  }
}

export function encryptNodeSource(value: JsonObject, rules?: ProxyRewriteRule[]) {
  return PREFIX + encryptJson(storedNodeSource(value, rules));
}

export function readNodeSourceRewriteRules(ciphertext: unknown) {
  const text = String(ciphertext ?? '');
  return text.startsWith(PREFIX) ? projectRewriteRules(decryptJson(text.slice(PREFIX.length))) : undefined;
}

function clientOptionsOf(stored: JsonValue): ClientOptions | undefined {
  if (isJsonObject(stored) && isJsonObject(stored.extensions) && isJsonObject(stored.extensions.shadowrocket)) {
    return { shadowrocket: stored.extensions.shadowrocket };
  }
}

export function readClientOptions(ciphertext: unknown) {
  const text = String(ciphertext ?? '');
  return text.startsWith(PREFIX) ? clientOptionsOf(decryptJson(text.slice(PREFIX.length))) : undefined;
}

export function decryptResource(kind: StoredResourceKind, ciphertext: unknown): JsonValue {
  const text = String(ciphertext ?? '');
  return text.startsWith(PREFIX) ? projectResource(kind, decryptJson(text.slice(PREFIX.length))) : decryptJson(text);
}

export function decryptResourceObject(kind: Exclude<StoredResourceKind, 'extension'>, ciphertext: unknown): JsonObject {
  const value = decryptResource(kind, ciphertext);
  if (!isJsonObject(value)) throw new Error('Expected a configuration mapping');
  return value;
}

// Routing identifiers in storage describe semantics, not the syntax emitted by
// a client. Unsupported rules keep the dialect in their identifier.
const matchIds = new Map([
  ['MATCH', 'fallback'], ['DOMAIN', 'host.exact'], ['DOMAIN-SUFFIX', 'host.suffix'],
  ['DOMAIN-KEYWORD', 'host.keyword'], ['DOMAIN-WILDCARD', 'host.wildcard'],
  ['DOMAIN-REGEX', 'host.regex'], ['IP-CIDR', 'ip.v4-cidr'], ['IP-CIDR6', 'ip.v6-cidr'],
  ['GEOIP', 'ip.region'], ['IP-ASN', 'ip.asn'], ['NETWORK', 'transport'],
  ['PROTOCOL', 'protocol'], ['DST-PORT', 'port.destination'], ['SRC-PORT', 'port.source'],
  ['SRC-IP', 'ip.source'], ['RULE-SET', 'rule-set'], ['PROCESS-NAME', 'process.name'],
  ['PROCESS-PATH', 'process.path'], ['AND', 'logic.all'], ['OR', 'logic.any'], ['NOT', 'logic.not'],
  ['USER-AGENT', 'http.user-agent'], ['URL-REGEX', 'http.url-regex']
]);
const apiMatches = new Map([...matchIds].map(([api, canonical]) => [canonical, api]));
export function storeMatchType(value: string) {
  return matchIds.get(value) ?? `stash:${value}`;
}
export function projectMatchType(value: string) {
  return apiMatches.get(value) ?? (value.startsWith('stash:') ? value.slice(6) : value);
}

function transformSnapshot(snapshot: Snapshot, write: boolean): Snapshot {
  const transform = (kind: StoredResourceKind, value: JsonValue) =>
    write ? storeResource(kind, value) : projectResource(kind, value);
  function transformWithOptions(kind: 'settings' | 'policyGroup' | 'ruleSource', value: JsonObject, options: ClientOptions | undefined) {
    return {
      value: (write ? storeResource(kind, value, options) : projectResource(kind, value)) as JsonObject,
      clientOptions: write ? undefined : clientOptionsOf(value)
    };
  }
  const settings = transformWithOptions('settings', snapshot.profile.settings, snapshot.profile.clientOptions);
  return {
    ...snapshot,
    profile: { ...snapshot.profile, settings: settings.value, clientOptions: settings.clientOptions },
    proxies: snapshot.proxies.map((item) => ({ ...item, config: transform('node', item.config) as JsonObject })),
    proxyProviders: snapshot.proxyProviders.map((item) => {
      const { rewriteRules, ...rest } = item;
      if (write) return { ...rest, config: storedNodeSource(item.config, rewriteRules) };
      const rules = projectRewriteRules(item.config);
      return { ...rest, config: projectResource('nodeSource', item.config) as JsonObject, ...(rules ? { rewriteRules: rules } : {}) };
    }),
    proxyGroups: snapshot.proxyGroups.map((item) => {
      const options = transformWithOptions('policyGroup', item.config, item.clientOptions);
      return { ...item, config: options.value, clientOptions: options.clientOptions };
    }),
    ruleProviders: snapshot.ruleProviders.map((item) => {
      const options = transformWithOptions('ruleSource', item.config, item.clientOptions);
      return { ...item, config: options.value, clientOptions: options.clientOptions };
    }),
    rules: snapshot.rules.map((rule) => ({ ...rule, type: (write ? storeMatchType : projectMatchType)(rule.type) })),
    advancedSections: snapshot.advancedSections.map((item) => ({ ...item, value: transform('extension', item.value) }))
  };
}

export function encryptRevision(snapshot: Snapshot) {
  return PREFIX + encryptJson(transformSnapshot(snapshot, true) as unknown as JsonValue);
}

export function decryptRevision(ciphertext: string): Snapshot {
  return ciphertext.startsWith(PREFIX)
    ? transformSnapshot(decryptJson<Snapshot>(ciphertext.slice(PREFIX.length)), false)
    : decryptJson<Snapshot>(ciphertext);
}

export function upgradeResource(kind: StoredResourceKind, ciphertext: string) {
  return ciphertext.startsWith(PREFIX) ? ciphertext : encryptResource(kind, decryptJson(ciphertext));
}
