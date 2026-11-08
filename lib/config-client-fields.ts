import type { JsonObject } from './types';

export const COMMON_POLICY_GROUP_FIELDS = [
  'proxies', 'use', 'filter', 'hidden', 'interval', 'tolerance', 'url', 'benchmark-url', 'benchmark-timeout', 'strategy'
] as const;
export const COMMON_RULE_SOURCE_FIELDS = ['url', 'headers', 'path', 'interval', 'format'] as const;

export function splitClientFields(resource: string, config: JsonObject) {
  const keys: readonly string[] = resource === 'proxy-groups' ? COMMON_POLICY_GROUP_FIELDS : COMMON_RULE_SOURCE_FIELDS;
  const entries = Object.entries(config);
  return {
    common: Object.fromEntries(entries.filter(([key]) => keys.includes(key))),
    stash: Object.fromEntries(entries.filter(([key]) => !keys.includes(key)))
  };
}
