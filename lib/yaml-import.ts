import { LineCounter, parseDocument } from 'yaml';

import { HttpError } from './http';
import { parseRuleLine } from './rules';
import {
  PROXY_GROUP_TYPES,
  RESERVED_TOP_LEVEL_KEYS,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type LogLevel,
  type Profile,
  type ProfileMode,
  type ProxyGroupType,
  type RuleProviderType
} from './types';

export interface ImportedDocument {
  mode: ProfileMode;
  targetPlatform?: Profile['targetPlatform'];
  logLevel: LogLevel;
  ipv6: boolean | null;
  settings: JsonObject;
  proxies: Array<{ name: string; type: string; config: JsonObject }>;
  proxyProviders: Array<{ name: string; config: JsonObject; requiresUrl: boolean }>;
  proxyGroups: Array<{ name: string; type: ProxyGroupType; config: JsonObject }>;
  ruleProviders: Array<{
    name: string;
    displayName?: string;
    behavior: string;
    providerType: RuleProviderType;
    config: JsonObject;
    entries: string[];
  }>;
  rules: Array<{
    type: string;
    payload: string;
    policy: string;
    options: string[];
    enabled: boolean;
    note: string;
  }>;
  hosts: Array<{ pattern: string; value: string }>;
  advancedSections: Array<{ key: string; value: JsonValue }>;
}

function invalid(field: string, expected: string): never {
  throw new HttpError(400, `${field}: ${expected}`);
}

// JSON is the persistence format. Reject values that JSON.stringify would silently
// coerce, discard or fail to serialize, rather than changing the user's YAML.
function assertJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value) {
    invalid('Configuration', 'only finite JSON-compatible YAML values are supported');
  }
  if (ancestors.has(value)) invalid('Configuration', 'cyclic YAML aliases are not supported');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalid('Configuration', 'special YAML value types are not supported');
  }
  ancestors.add(value);
  for (const item of Object.values(value)) assertJsonValue(item, ancestors);
  ancestors.delete(value);
}

function mapping(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) invalid(field, 'expected a YAML mapping');
  return value;
}

function optionalMapping(source: JsonObject, field: string): JsonObject {
  return Object.hasOwn(source, field) ? mapping(source[field], field) : {};
}

function optionalList(source: JsonObject, field: string): JsonValue[] {
  if (!Object.hasOwn(source, field)) return [];
  if (!Array.isArray(source[field])) invalid(field, 'expected a YAML sequence');
  return source[field];
}

function requiredString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(field, 'expected a non-empty string');
  return value;
}

function optionalString(source: JsonObject, key: string, field: string): void {
  if (Object.hasOwn(source, key) && typeof source[key] !== 'string') invalid(`${field}.${key}`, 'expected a string');
}

function uniqueName(value: JsonValue | undefined, field: string, seen: Set<string>): string {
  const name = requiredString(value, field);
  if (seen.has(name)) invalid(field, 'duplicate resource name');
  seen.add(name);
  return name;
}

function headers(source: JsonObject, field: string): void {
  if (!Object.hasOwn(source, 'headers')) return;
  const values = mapping(source.headers, `${field}.headers`);
  for (const value of Object.values(values)) {
    if (typeof value !== 'string' && !(Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
      invalid(`${field}.headers`, 'header values must be strings or string sequences');
    }
  }
}

function documentFromYaml(value: unknown): ImportedDocument {
  assertJsonValue(value);
  const source = mapping(value, 'Configuration');
  const mode = Object.hasOwn(source, 'mode') ? source.mode : 'rule';
  if (typeof mode !== 'string' || !['rule', 'global', 'direct'].includes(mode)) invalid('mode', 'expected rule, global or direct');
  const logLevel = Object.hasOwn(source, 'log-level') ? source['log-level'] : 'silent';
  if (typeof logLevel !== 'string' || !['silent', 'info', 'warning', 'error', 'debug'].includes(logLevel)) {
    invalid('log-level', 'expected silent, info, warning, error or debug');
  }
  if (Object.hasOwn(source, 'ipv6') && typeof source.ipv6 !== 'boolean') invalid('ipv6', 'expected a boolean');

  const policyNames = new Set<string>();
  const proxies = optionalList(source, 'proxies').map((raw, index) => {
    const field = `proxies[${index}]`, item = mapping(raw, field);
    const name = uniqueName(item.name, `${field}.name`, policyNames);
    const type = requiredString(item.type, `${field}.type`);
    const { name: _name, type: _type, ...config } = item;
    return { name, type, config };
  });
  const proxyGroups = optionalList(source, 'proxy-groups').map((raw, index) => {
    const field = `proxy-groups[${index}]`, item = mapping(raw, field);
    const name = uniqueName(item.name, `${field}.name`, policyNames);
    const type = requiredString(item.type, `${field}.type`) as ProxyGroupType;
    if (!PROXY_GROUP_TYPES.includes(type)) invalid(`${field}.type`, 'unsupported strategy group type');
    for (const key of ['proxies', 'use']) {
      if (Object.hasOwn(item, key) && (!Array.isArray(item[key]) || !item[key].every((entry) => typeof entry === 'string'))) {
        invalid(`${field}.${key}`, 'expected a string sequence');
      }
    }
    const { name: _name, type: _type, ...config } = item;
    return { name, type, config };
  });
  const proxyProviders = Object.entries(optionalMapping(source, 'proxy-providers')).map(([name, raw], index) => {
    const field = `proxy-providers[${index}]`, item = mapping(raw, field);
    requiredString(name, `${field}.name`);
    optionalString(item, 'url', field);
    optionalString(item, 'path', field);
    headers(item, field);
    const config = { ...item };
    const url = typeof config.url === 'string' ? config.url : '';
    const placeholder = !url || url.startsWith('https://example.invalid/');
    if (placeholder) delete config.url;
    return { name, config, requiresUrl: placeholder && (typeof item.url === 'string' || !config.path) };
  });
  const ruleProviders = Object.entries(optionalMapping(source, 'rule-providers')).map(([name, raw], index) => {
    const field = `rule-providers[${index}]`, item = mapping(raw, field);
    requiredString(name, `${field}.name`);
    for (const key of ['behavior', 'type', 'url', 'path']) optionalString(item, key, field);
    headers(item, field);
    const config = { ...item };
    const behavior = typeof item.behavior === 'string' ? item.behavior : 'classical';
    const inline = item.type === 'inline';
    const providerType: RuleProviderType = inline ? 'inline' : typeof item.url === 'string' ? 'remote' : 'local';
    let entries: string[] = [];
    if (inline) {
      if (Object.hasOwn(item, 'payload') && (!Array.isArray(item.payload) || !item.payload.every((entry) => typeof entry === 'string'))) {
        invalid(`${field}.payload`, 'expected a string sequence');
      }
      entries = (item.payload as string[] | undefined) || [];
      delete config.type;
      delete config.payload;
    }
    return { name, behavior, providerType, config, entries };
  });

  const rules = Object.hasOwn(source, 'rules')
    ? optionalList(source, 'rules').map((item, index) => {
        if (typeof item !== 'string') invalid(`rules[${index}]`, 'expected a rule string');
        try {
          return { ...parseRuleLine(item), enabled: true, note: '' };
        } catch {
          invalid(`rules[${index}]`, 'invalid rule syntax');
        }
      })
    : [{ type: 'MATCH', payload: '', policy: 'DIRECT', options: [], enabled: true, note: '' }];
  const hosts = Object.entries(optionalMapping(source, 'hosts')).map(([pattern, value], index) => {
    requiredString(pattern, `hosts[${index}].pattern`);
    return { pattern, value: requiredString(value, `hosts[${index}].value`) };
  });
  return {
    mode: mode as ProfileMode,
    logLevel: logLevel as LogLevel,
    ipv6: typeof source.ipv6 === 'boolean' ? source.ipv6 : null,
    settings: { dns: optionalMapping(source, 'dns') },
    proxies,
    proxyGroups,
    proxyProviders,
    ruleProviders,
    rules,
    hosts,
    advancedSections: Object.entries(source)
      .filter(([key]) => !RESERVED_TOP_LEVEL_KEYS.has(key))
      .map(([key, value]) => ({ key, value }))
  };
}

export function parseYamlDocument(yamlText: string): ImportedDocument {
  const lineCounter = new LineCounter();
  try {
    const document = parseDocument(yamlText, {
      lineCounter,
      prettyErrors: false,
      stringKeys: true,
      logLevel: 'silent'
    });
    const problem = document.errors[0] || document.warnings[0];
    if (problem) {
      const position = lineCounter.linePos(problem.pos[0]);
      // Parser messages can contain private URLs and headers from the source.
      throw new HttpError(400, `Configuration YAML is invalid at line ${position.line}, column ${position.col} (${problem.code})`);
    }
    return documentFromYaml(document.toJS({ maxAliasCount: 100 }));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Configuration YAML is invalid or contains unsupported aliases');
  }
}
