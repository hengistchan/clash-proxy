import { HttpError } from './http';
import {
  createHost,
  createProxy,
  createProxyGroup,
  createProxyProvider,
  createRule,
  createRuleProvider,
  deleteHost,
  deleteProxy,
  deleteProxyGroup,
  deleteProxyProvider,
  deleteRule,
  deleteRuleProvider,
  getSnapshot,
  updateHost,
  updateProxy,
  updateProxyGroup,
  updateProxyProvider,
  updateRule,
  updateRuleProvider
} from './repository';
import {
  hostSchema,
  proxyGroupSchema,
  proxyProviderSchema,
  proxySchema,
  ruleProviderSchema,
  ruleSchema
} from './schemas';
import type { ResourceKind, Snapshot } from './types';

export const RESOURCE_KINDS: ResourceKind[] = [
  'proxies',
  'proxy-providers',
  'proxy-groups',
  'rule-providers',
  'rules',
  'hosts'
];

export function asResourceKind(value: string): ResourceKind {
  if (RESOURCE_KINDS.includes(value as ResourceKind)) {
    return value as ResourceKind;
  }
  throw new HttpError(404, 'Resource collection not found');
}

export function listResources(snapshot: Snapshot, kind: ResourceKind): unknown[] {
  switch (kind) {
    case 'proxies':
      return snapshot.proxies;
    case 'proxy-providers':
      return snapshot.proxyProviders;
    case 'proxy-groups':
      return snapshot.proxyGroups;
    case 'rule-providers':
      return snapshot.ruleProviders;
    case 'rules':
      return snapshot.rules;
    case 'hosts':
      return snapshot.hosts;
  }
}

export function findResource(
  snapshot: Snapshot,
  kind: ResourceKind,
  id: number
): unknown {
  const item = listResources(snapshot, kind).find(
    (entry) => Number((entry as { id: number }).id) === id
  );
  if (!item) throw new HttpError(404, 'Resource not found');
  return item;
}

export function createResource(
  profileId: number,
  kind: ResourceKind,
  raw: unknown
): unknown {
  switch (kind) {
    case 'proxies':
      return createProxy(profileId, proxySchema.parse(raw));
    case 'proxy-providers':
      return createProxyProvider(profileId, proxyProviderSchema.parse(raw));
    case 'proxy-groups':
      return createProxyGroup(profileId, proxyGroupSchema.parse(raw));
    case 'rule-providers':
      return createRuleProvider(profileId, ruleProviderSchema.parse(raw));
    case 'rules':
      return createRule(profileId, ruleSchema.parse(raw));
    case 'hosts':
      return createHost(profileId, hostSchema.parse(raw));
  }
}

export function updateResource(
  profileId: number,
  kind: ResourceKind,
  id: number,
  raw: unknown
): unknown {
  switch (kind) {
    case 'proxies':
      return updateProxy(profileId, id, proxySchema.parse(raw));
    case 'proxy-providers':
      return updateProxyProvider(profileId, id, proxyProviderSchema.parse(raw));
    case 'proxy-groups':
      return updateProxyGroup(profileId, id, proxyGroupSchema.parse(raw));
    case 'rule-providers':
      return updateRuleProvider(profileId, id, ruleProviderSchema.parse(raw));
    case 'rules':
      return updateRule(profileId, id, ruleSchema.parse(raw));
    case 'hosts':
      return updateHost(profileId, id, hostSchema.parse(raw));
  }
}

export function deleteResource(
  profileId: number,
  kind: ResourceKind,
  id: number
): void {
  switch (kind) {
    case 'proxies':
      deleteProxy(profileId, id);
      return;
    case 'proxy-providers':
      deleteProxyProvider(profileId, id);
      return;
    case 'proxy-groups':
      deleteProxyGroup(profileId, id);
      return;
    case 'rule-providers':
      deleteRuleProvider(profileId, id);
      return;
    case 'rules':
      deleteRule(profileId, id);
      return;
    case 'hosts':
      deleteHost(profileId, id);
      return;
  }
}

export function getResource(
  profileId: number,
  kind: ResourceKind,
  id: number
): unknown {
  return findResource(getSnapshot(profileId), kind, id);
}
