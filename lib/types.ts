export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ProfileMode = 'rule' | 'global' | 'direct';
export type LogLevel = 'silent' | 'info' | 'warning' | 'error' | 'debug';
export type ProxyGroupType =
  | 'select'
  | 'url-test'
  | 'fallback'
  | 'load-balance'
  | 'relay';
export type RuleProviderType = 'inline' | 'remote' | 'local';

export interface Profile {
  id: number;
  name: string;
  mode: ProfileMode;
  logLevel: LogLevel;
  ipv6: boolean | null;
  settings: JsonObject;
  active: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyNode {
  id: number;
  name: string;
  type: string;
  config: JsonObject;
  sortOrder: number;
}

export interface ProxyProvider {
  id: number;
  name: string;
  config: JsonObject;
  requiresUrl: boolean;
  sortOrder: number;
}

export interface ProxyGroup {
  id: number;
  name: string;
  type: ProxyGroupType;
  config: JsonObject;
  sortOrder: number;
}

export interface RuleProviderEntry {
  id: number;
  value: string;
  sortOrder: number;
}

export interface RuleProvider {
  id: number;
  name: string;
  behavior: string;
  providerType: RuleProviderType;
  config: JsonObject;
  entries: RuleProviderEntry[];
  sortOrder: number;
}

export interface StashRule {
  id: number;
  priority: number;
  type: string;
  payload: string;
  policy: string;
  options: string[];
  enabled: boolean;
  note: string;
}

export interface HostEntry {
  id: number;
  pattern: string;
  value: string;
  sortOrder: number;
}

export interface AdvancedSection {
  id: number;
  key: string;
  value: JsonValue;
  sortOrder: number;
}

export interface Snapshot {
  profile: Profile;
  proxies: ProxyNode[];
  proxyProviders: ProxyProvider[];
  proxyGroups: ProxyGroup[];
  ruleProviders: RuleProvider[];
  rules: StashRule[];
  hosts: HostEntry[];
  advancedSections: AdvancedSection[];
}

export type ResourceKind =
  | 'proxies'
  | 'proxy-providers'
  | 'proxy-groups'
  | 'rule-providers'
  | 'rules'
  | 'hosts';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  resource?: string;
  resourceId?: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ExportOptions {
  subscriptionUrl: string;
  template?: string;
}

export const BUILTIN_POLICIES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'] as const;

export const RESERVED_TOP_LEVEL_KEYS = new Set([
  'mode',
  'log-level',
  'ipv6',
  'dns',
  'hosts',
  'proxies',
  'proxy-groups',
  'proxy-providers',
  'rule-providers',
  'rules'
]);

export const RULE_TYPES = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-WILDCARD',
  'DOMAIN-REGEX',
  'GEOIP',
  'IP-ASN',
  'IP-CIDR',
  'IP-CIDR6',
  'NETWORK',
  'PROTOCOL',
  'DST-PORT',
  'SRC-IP',
  'SRC-PORT',
  'RULE-SET',
  'GEOSITE',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'SCRIPT',
  'AND',
  'OR',
  'NOT',
  'USER-AGENT',
  'URL-REGEX',
  'MATCH'
] as const;

export const RULE_OPTIONS = ['no-resolve', 'no-track', 'pre-matching'] as const;

export const PROXY_GROUP_TYPES: ProxyGroupType[] = [
  'select',
  'url-test',
  'fallback',
  'load-balance',
  'relay'
];

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
