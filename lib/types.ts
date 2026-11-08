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
export type ClientOptions = { shadowrocket?: JsonObject };
export const SHADOWROCKET_BUILTINS = ['PROXY', 'REJECT-NO-DROP', 'REJECT-TINYGIF', 'REJECT-DICT', 'REJECT-ARRAY', 'REJECT-200'] as const;

export interface Profile {
  id: number;
  name: string;
  mode: ProfileMode;
  logLevel: LogLevel;
  ipv6: boolean | null;
  settings: JsonObject;
  clientOptions?: ClientOptions;
  targetPlatform: 'any' | 'ios' | 'tvos' | 'macos';
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
  sourceType: 'remote' | 'local';
  sourceConfigured: boolean;
  headersConfigured: boolean;
  sortOrder: number;
  rewriteRules?: ProxyRewriteRule[];
}

export type ProxyRewriteValue = string | number | boolean;

export interface ProxyRewriteRule {
  matchName: string;
  protocol?: string;
  operation: 'fill' | 'set';
  field: string;
  value: ProxyRewriteValue;
}

export interface ProxyGroup {
  id: number;
  name: string;
  type: ProxyGroupType;
  config: JsonObject;
  clientOptions?: ClientOptions;
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
  displayName: string;
  behavior: string;
  providerType: RuleProviderType;
  sourceConfigured?: boolean;
  headersConfigured?: boolean;
  shadowrocketSourceConfigured?: boolean;
  config: JsonObject;
  clientOptions?: ClientOptions;
  entries: RuleProviderEntry[];
  sortOrder: number;
}

export interface RoutingRule {
  id: number;
  priority: number;
  type: string;
  payload: string;
  policy: string;
  options: string[];
  enabled: boolean;
  note: string;
}
export type StashRule = RoutingRule;

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
  rules: RoutingRule[];
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

export const BUILTIN_POLICIES = [
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS'
] as const;

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
