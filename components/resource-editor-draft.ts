import type { JsonObject, ProxyRewriteRule, ResourceKind, Snapshot } from '@/lib/types';
import { splitClientFields } from '@/lib/config-client-fields';
import type { EditorPreset } from './relationships-view';
import type { EditableResource } from './use-resource-editor';

export function parseObject(text: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text || '{}');
  } catch {
    throw new Error(`${label}不是合法 JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return value as JsonObject;
}

export function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function configWithout(config: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !keys.includes(key))
  ) as JsonObject;
}

export function snapshotResources(snapshot: Snapshot, resource: ResourceKind) {
  return {
    proxies: snapshot.proxies, 'proxy-providers': snapshot.proxyProviders,
    'proxy-groups': snapshot.proxyGroups, 'rule-providers': snapshot.ruleProviders,
    rules: snapshot.rules, hosts: snapshot.hosts
  }[resource];
}

export const MANAGED_GROUP_COMMON_KEYS = ['proxies', 'use', 'filter', 'hidden'];
export const MANAGED_GROUP_STASH_KEYS = [
  'proxies',
  'use',
  'filter',
  'hidden',
  'exclude-filter',
  'exclude-type',
  'include-all',
  'include-all-proxies',
  'include-all-providers',
  'policy-priority',
  'benchmark-disabled'
];

export function resourceEditorDraft(snapshot: Snapshot, resource: ResourceKind, existing: EditableResource, initialValues?: EditorPreset) {
    const item = existing as unknown as Record<string, unknown> | null;
    const config = (item?.config || {}) as JsonObject;
    const scoped = resource === 'proxy-groups' || resource === 'rule-providers';
    const separated = scoped ? splitClientFields(resource, config) : { common: config, stash: {} };
    const clients = item?.clientOptions as { shadowrocket?: JsonObject } | undefined;
    const itemType = String(item?.type || '');
    const itemPayload = String(item?.payload || initialValues?.payload || '');
    const terminal = snapshot.rules.at(-1);
    const defaultPriority = terminal?.type === 'MATCH'
      ? terminal.priority
      : snapshot.rules.length + 1;
    return {
      name: String(item?.name || item?.pattern || ''),
      displayName: String(item?.displayName || ''),
      type: String(
        item?.type ||
          initialValues?.type ||
          (resource === 'rules'
            ? 'DOMAIN'
            : resource === 'proxy-groups'
              ? 'select'
              : '')
      ),
      configText: JSON.stringify(
        resource === 'proxy-groups' ? configWithout(separated.common, MANAGED_GROUP_COMMON_KEYS) : separated.common,
        null, 2
      ),
      stashText: JSON.stringify(
        configWithout(
          separated.stash,
          resource === 'rule-providers'
            ? ['type', 'payload', 'behavior']
            : resource === 'proxy-groups'
              ? MANAGED_GROUP_STASH_KEYS
              : []
        ),
        null, 2
      ),
      shadowrocketText: JSON.stringify(scoped ? clients?.shadowrocket ?? {} : {}, null, 2),
      shadowrocketSourceUrl: '',
      clearShadowrocketSource: false,
      sourceType: String(item?.sourceType || 'remote'),
      sourceUrl: '',
      sourceHeaders: '',
      clearSource: false,
      clearHeaders: false,
      rewriteRules: (item?.rewriteRules as ProxyRewriteRule[] | undefined) ?? [],
      providerBehavior: String(item?.behavior || 'domain'),
      providerType: String(item?.providerType || 'inline'),
      entriesText: Array.isArray(item?.entries)
        ? (item.entries as Array<{ value: string }>)
            .map((entry) => entry.value)
            .join('\n')
        : '',
      groupProxies: (initialValues?.groupProxies || textArray(config.proxies)).join('\n'),
      groupUse: (initialValues?.groupUse || textArray(config.use)).join('\n'),
      groupFilter: String(config.filter || ''),
      groupExcludeFilter: String(config['exclude-filter'] || ''),
      groupExcludeType: String(config['exclude-type'] || ''),
      groupPolicyPriority: String(config['policy-priority'] || ''),
      groupIncludeAll: config['include-all'] === true,
      groupIncludeAllProxies: config['include-all-proxies'] === true,
      groupIncludeAllProviders: config['include-all-providers'] === true,
      groupHidden: config.hidden === true,
      groupBenchmarkDisabled: config['benchmark-disabled'] === true,
      rulePayload: itemType === 'RULE-SET' && !itemPayload
        ? snapshot.ruleProviders[0]?.name || ''
        : itemPayload,
      rulePolicy: String(item?.policy || initialValues?.policy || 'DIRECT'),
      ruleOptions: Array.isArray(item?.options) ? (item.options as string[]) : [],
      ruleEnabled: item?.enabled === undefined ? true : Boolean(item.enabled),
      ruleNote: String(item?.note || ''),
      rulePriority: String(item?.priority || defaultPriority),
      hostPattern: String(item?.pattern || ''),
      hostValue: String(item?.value || '')
    };
}
