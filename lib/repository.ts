import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { decryptJson, encryptJson } from './crypto';
import { refreshCompiledConfig } from './compilation';
import { validateSubscriptionUrl } from './provider-source';
import { getDb, transaction } from './db';
import { HttpError } from './http';
import {
  normalizeRuleInput,
  parseRuleLine,
  serializeRule,
  ruleSetNames
} from './rules';
import type {
  AdvancedSection,
  HostEntry,
  JsonObject,
  JsonValue,
  LogLevel,
  Profile,
  ProfileMode,
  ProxyGroup,
  ProxyGroupType,
  ProxyNode,
  ProxyProvider,
  RuleProvider,
  RuleProviderEntry,
  RuleProviderType,
  Snapshot,
  StashRule
} from './types';
import {
  BUILTIN_POLICIES,
  PROXY_GROUP_TYPES,
  RESERVED_TOP_LEVEL_KEYS,
  isJsonObject
} from './types';

type DbRow = Record<string, unknown>;

const REMOVED_TOP_LEVEL = new Set([
  'mode',
  'log-level',
  'ipv6',
  'dns',
  'hosts',
  'proxies',
  'proxy-providers',
  'proxy-groups',
  'rule-providers',
  'rules'
]);

function now(): string {
  return new Date().toISOString();
}

function asJsonObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function decryptObject(value: unknown): JsonObject {
  return decryptJson<JsonObject>(String(value || ''));
}

function mapProfile(row: DbRow): Profile {
  return {
    id: Number(row.id),
    name: String(row.name),
    mode: String(row.mode) as ProfileMode,
    logLevel: String(row.log_level) as LogLevel,
    ipv6:
      row.ipv6 === null || row.ipv6 === undefined ? null : Boolean(row.ipv6),
    settings: decryptObject(row.settings_ciphertext),
    targetPlatform: String(
      row.target_platform || 'any'
    ) as Profile['targetPlatform'],
    active: Boolean(row.active),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapProxy(row: DbRow): ProxyNode {
  return {
    id: Number(row.id),
    name: String(row.name),
    type: String(row.type),
    config: decryptObject(row.config_ciphertext),
    sortOrder: Number(row.sort_order)
  };
}

function mapProxyProvider(row: DbRow): ProxyProvider {
  const config = decryptObject(row.config_ciphertext);
  const sourceType =
    Boolean(row.requires_url) || config.url ? 'remote' : 'local';
  return {
    id: Number(row.id),
    name: String(row.name),
    config,
    requiresUrl: sourceType === 'remote' && !config.url,
    sourceType,
    sourceConfigured:
      sourceType === 'remote' ? Boolean(config.url) : Boolean(config.path),
    headersConfigured: Boolean(
      config.headers && Object.keys(config.headers).length
    ),
    sortOrder: Number(row.sort_order)
  };
}

function mapProxyGroup(row: DbRow): ProxyGroup {
  return {
    id: Number(row.id),
    name: String(row.name),
    type: String(row.type) as ProxyGroupType,
    config: decryptObject(row.config_ciphertext),
    sortOrder: Number(row.sort_order)
  };
}

function mapRuleProvider(
  row: DbRow,
  entries: RuleProviderEntry[]
): RuleProvider {
  return {
    id: Number(row.id),
    name: String(row.name),
    displayName: String(row.display_name || ''),
    behavior: String(row.behavior),
    providerType: String(row.provider_type) as RuleProviderType,
    config: decryptObject(row.config_ciphertext),
    entries,
    sortOrder: Number(row.sort_order)
  };
}

function mapRule(row: DbRow): StashRule {
  let options: string[] = [];
  try {
    const parsed = JSON.parse(String(row.options_json || '[]'));
    options = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    options = [];
  }
  return {
    id: Number(row.id),
    priority: Number(row.priority),
    type: String(row.type),
    payload: String(row.payload || ''),
    policy: String(row.policy),
    options,
    enabled: Boolean(row.enabled),
    note: String(row.note || '')
  };
}

function mapHost(row: DbRow): HostEntry {
  return {
    id: Number(row.id),
    pattern: String(row.pattern),
    value: String(row.value),
    sortOrder: Number(row.sort_order)
  };
}

function mapAdvanced(row: DbRow): AdvancedSection {
  return {
    id: Number(row.id),
    key: String(row.section_key),
    value: decryptJson<JsonValue>(String(row.value_ciphertext)),
    sortOrder: Number(row.sort_order)
  };
}

function getProfileRow(db: Database.Database, profileId: number): DbRow {
  const row = db
    .prepare('SELECT * FROM profiles WHERE id = ?')
    .get(profileId) as DbRow | undefined;
  if (!row) {
    throw new HttpError(404, 'Profile not found');
  }
  return row;
}

function listRuleEntries(
  db: Database.Database,
  providerId: number
): RuleProviderEntry[] {
  return db
    .prepare(
      'SELECT id, value, sort_order FROM rule_provider_entries WHERE provider_id = ? ORDER BY sort_order, id'
    )
    .all(providerId)
    .map((row) => {
      const item = row as DbRow;
      return {
        id: Number(item.id),
        value: String(item.value),
        sortOrder: Number(item.sort_order)
      };
    });
}

function snapshotFromDb(db: Database.Database, profileId: number): Snapshot {
  const profile = mapProfile(getProfileRow(db, profileId));
  const proxies = db
    .prepare(
      'SELECT * FROM proxies WHERE profile_id = ? ORDER BY sort_order, id'
    )
    .all(profileId)
    .map((row) => mapProxy(row as DbRow));
  const proxyProviders = db
    .prepare(
      'SELECT * FROM proxy_providers WHERE profile_id = ? ORDER BY sort_order, id'
    )
    .all(profileId)
    .map((row) => mapProxyProvider(row as DbRow));
  const proxyGroups = db
    .prepare(
      'SELECT * FROM proxy_groups WHERE profile_id = ? ORDER BY sort_order, id'
    )
    .all(profileId)
    .map((row) => mapProxyGroup(row as DbRow));
  const ruleProviderRows = db
    .prepare(
      'SELECT * FROM rule_providers WHERE profile_id = ? ORDER BY sort_order, id'
    )
    .all(profileId) as DbRow[];
  const entriesByProvider = new Map<number, RuleProviderEntry[]>();
  const entryRows = db
    .prepare(
      `SELECT entry.provider_id, entry.id, entry.value, entry.sort_order
       FROM rule_provider_entries AS entry
       INNER JOIN rule_providers AS provider ON provider.id = entry.provider_id
       WHERE provider.profile_id = ?
       ORDER BY entry.provider_id, entry.sort_order, entry.id`
    )
    .all(profileId) as DbRow[];
  for (const row of entryRows) {
    const providerId = Number(row.provider_id);
    const entries = entriesByProvider.get(providerId) || [];
    entries.push({
      id: Number(row.id),
      value: String(row.value),
      sortOrder: Number(row.sort_order)
    });
    entriesByProvider.set(providerId, entries);
  }
  const ruleProviders = ruleProviderRows.map((row) =>
    mapRuleProvider(row, entriesByProvider.get(Number(row.id)) || [])
  );
  const rules = db
    .prepare('SELECT * FROM rules WHERE profile_id = ? ORDER BY priority, id')
    .all(profileId)
    .map((row) => mapRule(row as DbRow));
  const hosts = db
    .prepare('SELECT * FROM hosts WHERE profile_id = ? ORDER BY sort_order, id')
    .all(profileId)
    .map((row) => mapHost(row as DbRow));
  const advancedSections = db
    .prepare(
      'SELECT * FROM advanced_sections WHERE profile_id = ? ORDER BY sort_order, id'
    )
    .all(profileId)
    .map((row) => mapAdvanced(row as DbRow));
  return {
    profile,
    proxies,
    proxyProviders,
    proxyGroups,
    ruleProviders,
    rules,
    hosts,
    advancedSections
  };
}

function recordRevision(db: Database.Database, profileId: number): number {
  const profile = mapProfile(getProfileRow(db, profileId));
  const nextRevision = profile.revision + 1;
  const touched = now();
  db.prepare(
    'UPDATE profiles SET revision = ?, updated_at = ? WHERE id = ?'
  ).run(nextRevision, touched, profileId);
  const updated = snapshotFromDb(db, profileId);
  db.prepare(
    'INSERT INTO revisions (profile_id, revision, config_ciphertext, created_at) VALUES (?, ?, ?, ?)'
  ).run(
    profileId,
    nextRevision,
    encryptJson(updated as unknown as JsonValue),
    touched
  );
  refreshCompiledConfig(db, updated);
  return nextRevision;
}

function nextSortOrder(
  db: Database.Database,
  table: string,
  profileId: number
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(sort_order), 0) AS maximum FROM ${table} WHERE profile_id = ?`
    )
    .get(profileId) as DbRow;
  return Number(row.maximum) + 1;
}

function deepReplaceString(
  value: JsonValue,
  replacement: (input: string) => string
): JsonValue {
  if (typeof value === 'string') return replacement(value);
  if (Array.isArray(value))
    return value.map((item) => deepReplaceString(item, replacement));
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        replacement(key),
        deepReplaceString(item, replacement)
      ])
    );
  }
  return value;
}

function replaceRuleSetReference(
  input: string,
  oldName: string,
  newName: string
): string {
  if (input.startsWith('rule-set:'))
    return (
      'rule-set:' +
      ruleSetNames(input)
        .map((name) => (name === oldName ? newName : name))
        .join(',')
    );
  return input.replaceAll(`RULE-SET,${oldName},`, `RULE-SET,${newName},`);
}

function rewriteRenamedResource(
  db: Database.Database,
  profileId: number,
  kind: string,
  oldName: string,
  newName: string
): void {
  if (kind === 'proxy-providers') {
    const groups = db
      .prepare(
        'SELECT id, config_ciphertext FROM proxy_groups WHERE profile_id = ?'
      )
      .all(profileId) as DbRow[];
    for (const group of groups) {
      const config = decryptObject(group.config_ciphertext);
      const use = Array.isArray(config.use)
        ? config.use.map((item) =>
            String(item) === oldName ? newName : String(item)
          )
        : config.use;
      if (Array.isArray(use) && use.some((item) => String(item) === newName)) {
        db.prepare(
          'UPDATE proxy_groups SET config_ciphertext = ? WHERE id = ?'
        ).run(encryptJson({ ...config, use }), Number(group.id));
      }
    }
    return;
  }

  if (kind === 'rule-providers') {
    db.prepare(
      "UPDATE rules SET payload = ? WHERE profile_id = ? AND type = 'RULE-SET' AND payload = ?"
    ).run(newName, profileId, oldName);
    const profile = getProfileRow(db, profileId);
    const settings = decryptJson<JsonObject>(
      String(profile.settings_ciphertext)
    );
    const changed = deepReplaceString(settings, (value) =>
      replaceRuleSetReference(value, oldName, newName)
    );
    db.prepare('UPDATE profiles SET settings_ciphertext = ? WHERE id = ?').run(
      encryptJson(changed),
      profileId
    );
    const advanced = db
      .prepare(
        'SELECT id, value_ciphertext FROM advanced_sections WHERE profile_id = ?'
      )
      .all(profileId) as DbRow[];
    for (const section of advanced) {
      const value = decryptJson<JsonValue>(String(section.value_ciphertext));
      const next = deepReplaceString(value, (item) =>
        replaceRuleSetReference(item, oldName, newName)
      );
      db.prepare(
        'UPDATE advanced_sections SET value_ciphertext = ? WHERE id = ?'
      ).run(encryptJson(next), Number(section.id));
    }
    return;
  }

  if (kind === 'proxies' || kind === 'proxy-groups') {
    db.prepare(
      'UPDATE rules SET policy = ? WHERE profile_id = ? AND policy = ?'
    ).run(newName, profileId, oldName);
    const groups = db
      .prepare(
        'SELECT id, config_ciphertext FROM proxy_groups WHERE profile_id = ?'
      )
      .all(profileId) as DbRow[];
    for (const group of groups) {
      const config = decryptObject(group.config_ciphertext);
      let changed = false;
      const updated = { ...config };
      if (Array.isArray(config.proxies)) {
        updated.proxies = config.proxies.map((item) => {
          if (String(item) === oldName) {
            changed = true;
            return newName;
          }
          return item;
        });
      }
      if (isJsonObject(config['ssid-policy'])) {
        const policy = { ...config['ssid-policy'] };
        for (const [ssid, target] of Object.entries(policy)) {
          if (String(target) === oldName) {
            policy[ssid] = newName;
            changed = true;
          }
        }
        updated['ssid-policy'] = policy;
      }
      if (changed) {
        db.prepare(
          'UPDATE proxy_groups SET config_ciphertext = ? WHERE id = ?'
        ).run(encryptJson(updated), Number(group.id));
      }
    }
  }
}

function collectReferences(
  snapshot: Snapshot,
  kind: string,
  name: string
): string[] {
  const references = new Set<string>();
  const groupUses = (group: ProxyGroup) =>
    Array.isArray(group.config.use) ? group.config.use.map(String) : [];
  const groupMembers = (group: ProxyGroup) =>
    Array.isArray(group.config.proxies) ? group.config.proxies.map(String) : [];
  const ssidPolicyTargets = (group: ProxyGroup) =>
    isJsonObject(group.config['ssid-policy'])
      ? Object.entries(group.config['ssid-policy']).map(([ssid, target]) => ({
          ssid,
          target: String(target)
        }))
      : [];

  if (kind === 'proxy-providers') {
    for (const group of snapshot.proxyGroups) {
      if (groupUses(group).includes(name)) {
        references.add(
          `strategy group “${group.name}” uses provider “${name}”`
        );
      }
    }
  } else if (kind === 'proxies' || kind === 'proxy-groups') {
    for (const group of snapshot.proxyGroups) {
      if (groupMembers(group).includes(name)) {
        references.add(`strategy group “${group.name}” contains “${name}”`);
      }
      for (const entry of ssidPolicyTargets(group)) {
        if (entry.target === name) {
          references.add(
            `strategy group “${group.name}” SSID policy “${entry.ssid}” targets “${name}”`
          );
        }
      }
    }
    for (const rule of snapshot.rules) {
      if (rule.policy === name) {
        references.add(`rule priority ${rule.priority} targets “${name}”`);
      }
    }
  } else if (kind === 'rule-providers') {
    for (const rule of snapshot.rules) {
      if (rule.type === 'RULE-SET' && rule.payload === name) {
        references.add(
          `rule priority ${rule.priority} references rule set “${name}”`
        );
      }
    }
    const scan = (value: JsonValue): boolean => {
      if (typeof value === 'string') {
        return ruleSetNames(value).includes(name);
      }
      if (Array.isArray(value)) return value.some((item) => scan(item));
      if (isJsonObject(value))
        return Object.entries(value).some(
          ([key, item]) => scan(key) || scan(item)
        );
      return false;
    };
    if (scan(snapshot.profile.settings)) {
      references.add(`DNS settings reference rule set “${name}”`);
    }
    for (const section of snapshot.advancedSections) {
      if (scan(section.value)) {
        references.add(
          `advanced section “${section.key}” references rule set “${name}”`
        );
      }
    }
  }
  return [...references];
}

function assertNoReferences(
  snapshot: Snapshot,
  kind: string,
  name: string
): void {
  const references = collectReferences(snapshot, kind, name);
  if (references.length) {
    throw new HttpError(
      409,
      `Resource is still referenced: ${references.join('; ')}`
    );
  }
}

function assertProfileNameAvailable(
  db: Database.Database,
  name: string,
  exceptId?: number
): void {
  const row = db
    .prepare(
      'SELECT id FROM profiles WHERE name = ? AND (? IS NULL OR id <> ?)'
    )
    .get(name, exceptId || null, exceptId || null);
  if (row) {
    throw new HttpError(409, `Profile name already exists: ${name}`);
  }
}

function assertUniqueName(
  db: Database.Database,
  table: string,
  profileId: number,
  name: string,
  exceptId?: number
): void {
  const row = db
    .prepare(
      `SELECT id FROM ${table} WHERE profile_id = ? AND name = ? AND (? IS NULL OR id <> ?)`
    )
    .get(profileId, name, exceptId || null, exceptId || null);
  if (row) {
    throw new HttpError(409, `Resource name already exists: ${name}`);
  }
}

function assertPolicyNameAvailable(
  db: Database.Database,
  profileId: number,
  name: string,
  kind: 'proxies' | 'proxy-groups',
  exceptId?: number
): void {
  const except = exceptId || null;
  const proxy = db
    .prepare(
      'SELECT id FROM proxies WHERE profile_id = ? AND name = ? AND (? IS NULL OR id <> ?)'
    )
    .get(profileId, name, except, except);
  const group = db
    .prepare(
      'SELECT id FROM proxy_groups WHERE profile_id = ? AND name = ? AND (? IS NULL OR id <> ?)'
    )
    .get(profileId, name, except, except);
  if ((kind === 'proxies' && group) || (kind === 'proxy-groups' && proxy)) {
    throw new HttpError(
      409,
      'Direct proxies and strategy groups must use unique policy names'
    );
  }
}

function normalizeImportedRules(rawRules: unknown[]): Array<{
  type: string;
  payload: string;
  policy: string;
  options: string[];
  enabled: boolean;
  note: string;
}> {
  return rawRules.map((item, index) => {
    if (typeof item !== 'string') {
      throw new HttpError(400, `rules[${index}] must be a rule string`);
    }
    const parsed = parseRuleLine(item);
    return { ...parsed, enabled: true, note: '' };
  });
}

function replaceProfileResources(
  db: Database.Database,
  profileId: number,
  document: {
    mode?: ProfileMode;
    targetPlatform?: Profile['targetPlatform'];
    logLevel?: LogLevel;
    ipv6?: boolean | null;
    settings: JsonObject;
    proxies: Array<{ name: string; type: string; config: JsonObject }>;
    proxyProviders: Array<{
      name: string;
      config: JsonObject;
      requiresUrl: boolean;
    }>;
    proxyGroups: Array<{
      name: string;
      type: ProxyGroupType;
      config: JsonObject;
    }>;
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
): void {
  getProfileRow(db, profileId);
  const touched = now();
  const existingSources = new Map(
    (
      db
        .prepare('SELECT * FROM proxy_providers WHERE profile_id = ?')
        .all(profileId) as DbRow[]
    ).map((row) => [String(row.name), decryptObject(row.config_ciphertext)])
  );
  const existingRuleSetNames = new Map(
    (
      db
        .prepare(
          'SELECT name, display_name FROM rule_providers WHERE profile_id = ?'
        )
        .all(profileId) as DbRow[]
    ).map((row) => [String(row.name), String(row.display_name || '')])
  );
  db.prepare('DELETE FROM proxies WHERE profile_id = ?').run(profileId);
  db.prepare('DELETE FROM proxy_providers WHERE profile_id = ?').run(profileId);
  db.prepare('DELETE FROM proxy_groups WHERE profile_id = ?').run(profileId);
  db.prepare('DELETE FROM rule_providers WHERE profile_id = ?').run(profileId);
  db.prepare('DELETE FROM rules WHERE profile_id = ?').run(profileId);
  db.prepare('DELETE FROM hosts WHERE profile_id = ?').run(profileId);
  db.prepare('DELETE FROM advanced_sections WHERE profile_id = ?').run(
    profileId
  );

  db.prepare(
    `UPDATE profiles SET mode = ?, log_level = ?, ipv6 = ?, settings_ciphertext = ?, updated_at = ?, target_platform = COALESCE(?, target_platform) WHERE id = ?`
  ).run(
    document.mode || 'rule',
    document.logLevel || 'silent',
    document.ipv6 === null || document.ipv6 === undefined
      ? null
      : Number(document.ipv6),
    encryptJson(document.settings),
    touched,
    document.targetPlatform ?? null,
    profileId
  );

  const proxyInsert = db.prepare(
    `INSERT INTO proxies (profile_id, name, type, config_ciphertext, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  );
  document.proxies.forEach((item, index) => {
    proxyInsert.run(
      profileId,
      item.name,
      item.type,
      encryptJson(item.config),
      index + 1
    );
  });

  const providerInsert = db.prepare(
    `INSERT INTO proxy_providers
       (profile_id, name, config_ciphertext, requires_url, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  );
  document.proxyProviders.forEach((item, index) => {
    providerInsert.run(
      profileId,
      item.name,
      encryptJson(
        item.requiresUrl && existingSources.has(item.name)
          ? {
              ...item.config,
              ...Object.fromEntries(
                Object.entries(existingSources.get(item.name)!).filter(
                  ([key]) => key === 'url' || key === 'headers'
                )
              )
            }
          : item.config
      ),
      Number(item.requiresUrl),
      index + 1
    );
  });

  const groupInsert = db.prepare(
    `INSERT INTO proxy_groups (profile_id, name, type, config_ciphertext, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  );
  document.proxyGroups.forEach((item, index) => {
    groupInsert.run(
      profileId,
      item.name,
      item.type,
      encryptJson(item.config),
      index + 1
    );
  });

  const ruleProviderInsert = db.prepare(
    `INSERT INTO rule_providers
       (profile_id, name, display_name, behavior, provider_type, config_ciphertext, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const entryInsert = db.prepare(
    'INSERT INTO rule_provider_entries (provider_id, value, sort_order) VALUES (?, ?, ?)'
  );
  document.ruleProviders.forEach((item, index) => {
    const result = ruleProviderInsert.run(
      profileId,
      item.name,
      item.displayName ?? existingRuleSetNames.get(item.name) ?? '',
      item.behavior,
      item.providerType,
      encryptJson(item.config),
      index + 1
    );
    item.entries.forEach((entry, entryIndex) => {
      entryInsert.run(result.lastInsertRowid, entry, entryIndex + 1);
    });
  });

  const ruleInsert = db.prepare(
    `INSERT INTO rules
       (profile_id, priority, type, payload, policy, options_json, enabled, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  document.rules.forEach((item, index) => {
    ruleInsert.run(
      profileId,
      index + 1,
      item.type,
      item.payload,
      item.policy,
      JSON.stringify(item.options),
      Number(item.enabled),
      item.note
    );
  });

  const hostInsert = db.prepare(
    'INSERT INTO hosts (profile_id, pattern, value, sort_order) VALUES (?, ?, ?, ?)'
  );
  document.hosts.forEach((item, index) => {
    hostInsert.run(profileId, item.pattern, item.value, index + 1);
  });

  const advancedInsert = db.prepare(
    `INSERT INTO advanced_sections (profile_id, section_key, value_ciphertext, sort_order)
     VALUES (?, ?, ?, ?)`
  );
  document.advancedSections.forEach((item, index) => {
    advancedInsert.run(profileId, item.key, encryptJson(item.value), index + 1);
  });
}

function documentFromYaml(value: unknown): {
  mode: ProfileMode;
  logLevel: LogLevel;
  ipv6: boolean | null;
  settings: JsonObject;
  proxies: Array<{ name: string; type: string; config: JsonObject }>;
  proxyProviders: Array<{
    name: string;
    config: JsonObject;
    requiresUrl: boolean;
  }>;
  proxyGroups: Array<{
    name: string;
    type: ProxyGroupType;
    config: JsonObject;
  }>;
  ruleProviders: Array<{
    name: string;
    behavior: string;
    providerType: RuleProviderType;
    config: JsonObject;
    entries: string[];
  }>;
  rules: ReturnType<typeof normalizeImportedRules>;
  hosts: Array<{ pattern: string; value: string }>;
  advancedSections: Array<{ key: string; value: JsonValue }>;
} {
  if (!isJsonObject(value)) {
    throw new HttpError(400, 'Configuration must be a YAML mapping');
  }
  const source = asJsonObject(value);
  const mode = ['rule', 'global', 'direct'].includes(String(source.mode))
    ? (String(source.mode) as ProfileMode)
    : 'rule';
  const logLevel = ['silent', 'info', 'warning', 'error', 'debug'].includes(
    String(source['log-level'])
  )
    ? (String(source['log-level']) as LogLevel)
    : 'silent';
  const ipv6 = typeof source.ipv6 === 'boolean' ? source.ipv6 : null;
  const dns = isJsonObject(source.dns) ? source.dns : {};
  const settings: JsonObject = { dns };

  const proxies: Array<{ name: string; type: string; config: JsonObject }> = [];
  if (Array.isArray(source.proxies)) {
    source.proxies.forEach((item, index) => {
      if (
        !isJsonObject(item) ||
        typeof item.name !== 'string' ||
        typeof item.type !== 'string'
      ) {
        throw new HttpError(400, `proxies[${index}] requires name and type`);
      }
      const config = { ...item };
      delete config.name;
      delete config.type;
      proxies.push({
        name: item.name,
        type: item.type,
        config: asJsonObject(config)
      });
    });
  }

  const proxyProviders: Array<{
    name: string;
    config: JsonObject;
    requiresUrl: boolean;
  }> = [];
  if (isJsonObject(source['proxy-providers'])) {
    for (const [name, raw] of Object.entries(source['proxy-providers'])) {
      if (!isJsonObject(raw)) continue;
      const config = asJsonObject(raw);
      const url = typeof config.url === 'string' ? config.url : '';
      const placeholder = !url || url.startsWith('https://example.invalid/');
      if (placeholder) {
        delete config.url;
      }
      proxyProviders.push({
        name,
        config,
        requiresUrl:
          placeholder && (typeof raw.url === 'string' || !config.path)
      });
    }
  }

  const proxyGroups: Array<{
    name: string;
    type: ProxyGroupType;
    config: JsonObject;
  }> = [];
  if (Array.isArray(source['proxy-groups'])) {
    source['proxy-groups'].forEach((item, index) => {
      if (
        !isJsonObject(item) ||
        typeof item.name !== 'string' ||
        typeof item.type !== 'string'
      ) {
        throw new HttpError(
          400,
          `proxy-groups[${index}] requires name and type`
        );
      }
      if (!PROXY_GROUP_TYPES.includes(item.type as ProxyGroupType)) {
        throw new HttpError(
          400,
          `Unsupported strategy group type: ${item.type}`
        );
      }
      const config = { ...item };
      delete config.name;
      delete config.type;
      proxyGroups.push({
        name: item.name,
        type: item.type as ProxyGroupType,
        config: asJsonObject(config)
      });
    });
  }

  const ruleProviders: Array<{
    name: string;
    behavior: string;
    providerType: RuleProviderType;
    config: JsonObject;
    entries: string[];
  }> = [];
  if (isJsonObject(source['rule-providers'])) {
    for (const [name, raw] of Object.entries(source['rule-providers'])) {
      if (!isJsonObject(raw)) continue;
      const config = asJsonObject(raw);
      const behavior =
        typeof raw.behavior === 'string' ? raw.behavior : 'classical';
      const inline = raw.type === 'inline';
      const providerType: RuleProviderType = inline
        ? 'inline'
        : typeof raw.url === 'string'
          ? 'remote'
          : 'local';
      let entries: string[] = [];
      if (inline) {
        entries = Array.isArray(raw.payload) ? raw.payload.map(String) : [];
        delete config.type;
        delete config.payload;
      }
      ruleProviders.push({ name, behavior, providerType, config, entries });
    }
  }

  const rules = Array.isArray(source.rules)
    ? normalizeImportedRules(source.rules)
    : [
        {
          type: 'MATCH',
          payload: '',
          policy: 'DIRECT',
          options: [],
          enabled: true,
          note: ''
        }
      ];

  const hosts: Array<{ pattern: string; value: string }> = [];
  if (isJsonObject(source.hosts)) {
    for (const [pattern, hostValue] of Object.entries(source.hosts)) {
      hosts.push({ pattern, value: String(hostValue) });
    }
  }

  const advancedSections: Array<{ key: string; value: JsonValue }> = [];
  for (const [key, raw] of Object.entries(source)) {
    if (!REMOVED_TOP_LEVEL.has(key)) {
      advancedSections.push({ key, value: asJsonValue(raw) });
    }
  }

  return {
    mode,
    logLevel,
    ipv6,
    settings,
    proxies,
    proxyProviders,
    proxyGroups,
    ruleProviders,
    rules,
    hosts,
    advancedSections
  };
}

function parseYamlDocument(
  yamlText: string
): ReturnType<typeof documentFromYaml> {
  try {
    return documentFromYaml(parseYaml(yamlText));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      `Configuration YAML is invalid: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
}

function seedTemplate(): string {
  const configured = process.env.STASH_TEMPLATE_DIR;
  const file = configured
    ? path.join(
        path.resolve(/*turbopackIgnore: true*/ configured),
        'Production.yaml'
      )
    : path.join(process.cwd(), 'Production.yaml');
  return readFileSync(/*turbopackIgnore: true*/ file, 'utf8');
}

let initialized = false;

export function ensureInitialized(): void {
  if (initialized) return;
  const db = getDb();
  const existing = db
    .prepare('SELECT COUNT(*) AS total FROM profiles')
    .get() as DbRow;
  if (Number(existing.total) > 0) {
    initialized = true;
    return;
  }
  const initialize = db.transaction(() => {
    const tx = db;
    const count = tx
      .prepare('SELECT COUNT(*) AS total FROM profiles')
      .get() as DbRow;
    if (Number(count.total) > 0) return;
    const created = tx
      .prepare(
        `INSERT INTO profiles
          (name, mode, log_level, ipv6, settings_ciphertext, active, revision, created_at, updated_at)
         VALUES (?, 'rule', 'info', NULL, ?, 1, 0, ?, ?)`
      )
      .run(
        process.env.STASH_SEED_EXAMPLE === '1' ? '示例配置' : '我的配置',
        encryptJson({ dns: {} }),
        now(),
        now()
      );
    const profileId = Number(created.lastInsertRowid);
    const document = parseYamlDocument(
      process.env.STASH_SEED_EXAMPLE === '1'
        ? seedTemplate()
        : 'mode: rule\nrules: ["MATCH,DIRECT"]\n'
    );
    replaceProfileResources(tx, profileId, document);
    recordRevision(tx, profileId);
  });
  initialize.immediate();
  initialized = true;
}

export function resetRepositoryForTests(): void {
  initialized = false;
}

export function listProfiles(): Profile[] {
  ensureInitialized();
  return getDb()
    .prepare('SELECT * FROM profiles ORDER BY active DESC, id')
    .all()
    .map((row) => mapProfile(row as DbRow));
}

export function getProfile(profileId: number): Profile {
  ensureInitialized();
  return mapProfile(getProfileRow(getDb(), profileId));
}

export function getActiveProfile(): Profile {
  ensureInitialized();
  const row = getDb()
    .prepare('SELECT * FROM profiles WHERE active = 1')
    .get() as DbRow | undefined;
  if (!row) {
    throw new HttpError(503, 'No active configuration profile');
  }
  return mapProfile(row);
}

export function createProfile(
  name: string,
  yamlText?: string,
  example = false
): Snapshot {
  ensureInitialized();
  return transaction((db) => {
    assertProfileNameAvailable(db, name);
    const result = db
      .prepare(
        `INSERT INTO profiles
          (name, mode, log_level, ipv6, settings_ciphertext, active, revision, created_at, updated_at)
         VALUES (?, 'rule', 'silent', NULL, ?, 0, 0, ?, ?)`
      )
      .run(name, encryptJson({ dns: {} }), now(), now());
    const profileId = Number(result.lastInsertRowid);
    const document =
      yamlText || example
        ? parseYamlDocument(yamlText || seedTemplate())
        : {
            mode: 'rule' as const,
            logLevel: 'silent' as const,
            ipv6: null,
            settings: { dns: { nameserver: ['223.5.5.5'] } },
            proxies: [],
            proxyProviders: [],
            proxyGroups: [],
            ruleProviders: [],
            rules: [
              {
                type: 'MATCH',
                payload: '',
                policy: 'DIRECT',
                options: [],
                enabled: true,
                note: ''
              }
            ],
            hosts: [],
            advancedSections: []
          };
    replaceProfileResources(db, profileId, document);
    recordRevision(db, profileId);
    return publicSnapshot(snapshotFromDb(db, profileId));
  });
}

export function updateProfile(
  profileId: number,
  patch: { name?: string; active?: boolean }
): Profile {
  ensureInitialized();
  return transaction((db) => {
    const current = getProfileRow(db, profileId);
    const name = patch.name ?? String(current.name);
    assertProfileNameAvailable(db, name, profileId);
    if (patch.active === false && Boolean(current.active)) {
      throw new HttpError(
        409,
        'Activate another profile instead of leaving no active profile'
      );
    }
    if (patch.active === true) {
      db.prepare('UPDATE profiles SET active = 0 WHERE active = 1').run();
    }
    db.prepare('UPDATE profiles SET name = ?, active = ? WHERE id = ?').run(
      name,
      patch.active === undefined
        ? Number(current.active)
        : Number(patch.active),
      profileId
    );
    recordRevision(db, profileId);
    return mapProfile(getProfileRow(db, profileId));
  });
}

export function deleteProfile(profileId: number): void {
  ensureInitialized();
  transaction((db) => {
    const profile = getProfileRow(db, profileId);
    if (Boolean(profile.active)) {
      throw new HttpError(409, 'The active profile cannot be deleted');
    }
    db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
  });
}

export function publicProvider(provider: ProxyProvider): ProxyProvider {
  const config = { ...provider.config };
  delete config.url;
  delete config.headers;
  return { ...provider, config };
}
function publicSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    proxyProviders: snapshot.proxyProviders.map(publicProvider)
  };
}
// Server compiler only. Do not serialize this snapshot into management responses.
export function getCompilationSnapshot(profileId: number): Snapshot {
  ensureInitialized();
  const db = getDb();
  return db.transaction(() => snapshotFromDb(db, profileId))();
}

export function getSnapshot(profileId: number): Snapshot {
  ensureInitialized();
  return publicSnapshot(getCompilationSnapshot(profileId));
}

export function saveSettings(
  profileId: number,
  input: {
    mode: ProfileMode;
    logLevel: LogLevel;
    ipv6?: boolean | null;
    settings: JsonObject;
    targetPlatform?: Profile['targetPlatform'];
  }
): Snapshot {
  ensureInitialized();
  return transaction((db) => {
    getProfileRow(db, profileId);
    db.prepare(
      `UPDATE profiles
       SET mode = ?, log_level = ?, ipv6 = ?, settings_ciphertext = ?, updated_at = ?, target_platform = COALESCE(?, target_platform)
       WHERE id = ?`
    ).run(
      input.mode,
      input.logLevel,
      input.ipv6 === undefined || input.ipv6 === null
        ? null
        : Number(input.ipv6),
      encryptJson(input.settings),
      now(),
      input.targetPlatform ?? null,
      profileId
    );
    recordRevision(db, profileId);
    return publicSnapshot(snapshotFromDb(db, profileId));
  });
}

export function createProxy(
  profileId: number,
  input: { name: string; type: string; config: JsonObject }
): ProxyNode {
  ensureInitialized();
  return transaction((db) => {
    getProfileRow(db, profileId);
    assertUniqueName(db, 'proxies', profileId, input.name);
    assertPolicyNameAvailable(db, profileId, input.name, 'proxies');
    const order = nextSortOrder(db, 'proxies', profileId);
    const result = db
      .prepare(
        `INSERT INTO proxies (profile_id, name, type, config_ciphertext, sort_order)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(profileId, input.name, input.type, encryptJson(input.config), order);
    recordRevision(db, profileId);
    return mapProxy(
      db
        .prepare('SELECT * FROM proxies WHERE id = ?')
        .get(result.lastInsertRowid) as DbRow
    );
  });
}

export function updateProxy(
  profileId: number,
  itemId: number,
  input: { name: string; type: string; config: JsonObject }
): ProxyNode {
  ensureInitialized();
  return transaction((db) => {
    const current = db
      .prepare('SELECT * FROM proxies WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!current) throw new HttpError(404, 'Direct proxy not found');
    assertUniqueName(db, 'proxies', profileId, input.name, itemId);
    assertPolicyNameAvailable(db, profileId, input.name, 'proxies', itemId);
    const oldName = String(current.name);
    db.prepare(
      'UPDATE proxies SET name = ?, type = ?, config_ciphertext = ? WHERE id = ?'
    ).run(input.name, input.type, encryptJson(input.config), itemId);
    if (oldName !== input.name) {
      rewriteRenamedResource(db, profileId, 'proxies', oldName, input.name);
    }
    recordRevision(db, profileId);
    return mapProxy(
      db.prepare('SELECT * FROM proxies WHERE id = ?').get(itemId) as DbRow
    );
  });
}

export function deleteProxy(profileId: number, itemId: number): void {
  ensureInitialized();
  transaction((db) => {
    const row = db
      .prepare('SELECT * FROM proxies WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!row) throw new HttpError(404, 'Direct proxy not found');
    const snapshot = snapshotFromDb(db, profileId);
    assertNoReferences(snapshot, 'proxies', String(row.name));
    db.prepare('DELETE FROM proxies WHERE id = ?').run(itemId);
    recordRevision(db, profileId);
  });
}

interface ProxyProviderInput {
  name: string;
  config: JsonObject;
  sourceType?: 'remote' | 'local';
  sourceUrl?: string;
  sourceHeaders?: JsonObject;
  clearSource?: boolean;
  clearHeaders?: boolean;
}
function providerConfig(
  input: ProxyProviderInput,
  current: JsonObject = {}
): JsonObject {
  const config = { ...input.config };
  if (input.clearSource) delete config.url;
  else if (input.sourceUrl !== undefined)
    config.url = validateSubscriptionUrl(input.sourceUrl);
  else if (typeof config.url === 'string')
    config.url = validateSubscriptionUrl(config.url);
  else if (current.url) config.url = current.url;
  if (input.clearHeaders) delete config.headers;
  else if (input.sourceHeaders !== undefined)
    config.headers = input.sourceHeaders;
  else if (config.headers === undefined && current.headers)
    config.headers = current.headers;
  if (input.sourceType === 'local') delete config.url;
  return config;
}

export function createProxyProvider(
  profileId: number,
  input: ProxyProviderInput
): ProxyProvider {
  ensureInitialized();
  return transaction((db) => {
    getProfileRow(db, profileId);
    assertUniqueName(db, 'proxy_providers', profileId, input.name);
    const order = nextSortOrder(db, 'proxy_providers', profileId);
    const config = providerConfig(input);
    const requiresUrl = input.sourceType
      ? input.sourceType === 'remote'
      : Boolean(config.url) || !config.path;
    const result = db
      .prepare(
        `INSERT INTO proxy_providers
         (profile_id, name, config_ciphertext, requires_url, sort_order)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        input.name,
        encryptJson(config),
        Number(requiresUrl),
        order
      );
    recordRevision(db, profileId);
    return publicProvider(
      mapProxyProvider(
        db
          .prepare('SELECT * FROM proxy_providers WHERE id = ?')
          .get(result.lastInsertRowid) as DbRow
      )
    );
  });
}

export function updateProxyProvider(
  profileId: number,
  itemId: number,
  input: ProxyProviderInput
): ProxyProvider {
  ensureInitialized();
  return transaction((db) => {
    const current = db
      .prepare('SELECT * FROM proxy_providers WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!current) throw new HttpError(404, 'Proxy provider not found');
    assertUniqueName(db, 'proxy_providers', profileId, input.name, itemId);
    const oldName = String(current.name);
    const config = providerConfig(
      input,
      decryptObject(current.config_ciphertext)
    );
    const requiresUrl = input.sourceType
      ? input.sourceType === 'remote'
      : mapProxyProvider(current).sourceType === 'remote';
    db.prepare(
      `UPDATE proxy_providers
       SET name = ?, config_ciphertext = ?, requires_url = ? WHERE id = ?`
    ).run(input.name, encryptJson(config), Number(requiresUrl), itemId);
    if (oldName !== input.name) {
      rewriteRenamedResource(
        db,
        profileId,
        'proxy-providers',
        oldName,
        input.name
      );
    }
    recordRevision(db, profileId);
    return publicProvider(
      mapProxyProvider(
        db
          .prepare('SELECT * FROM proxy_providers WHERE id = ?')
          .get(itemId) as DbRow
      )
    );
  });
}

export function deleteProxyProvider(profileId: number, itemId: number): void {
  ensureInitialized();
  transaction((db) => {
    const row = db
      .prepare('SELECT * FROM proxy_providers WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!row) throw new HttpError(404, 'Proxy provider not found');
    assertNoReferences(
      snapshotFromDb(db, profileId),
      'proxy-providers',
      String(row.name)
    );
    db.prepare('DELETE FROM proxy_providers WHERE id = ?').run(itemId);
    recordRevision(db, profileId);
  });
}

export function createProxyGroup(
  profileId: number,
  input: { name: string; type: ProxyGroupType; config: JsonObject }
): ProxyGroup {
  ensureInitialized();
  return transaction((db) => {
    getProfileRow(db, profileId);
    assertUniqueName(db, 'proxy_groups', profileId, input.name);
    assertPolicyNameAvailable(db, profileId, input.name, 'proxy-groups');
    const order = nextSortOrder(db, 'proxy_groups', profileId);
    const result = db
      .prepare(
        `INSERT INTO proxy_groups (profile_id, name, type, config_ciphertext, sort_order)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(profileId, input.name, input.type, encryptJson(input.config), order);
    recordRevision(db, profileId);
    return mapProxyGroup(
      db
        .prepare('SELECT * FROM proxy_groups WHERE id = ?')
        .get(result.lastInsertRowid) as DbRow
    );
  });
}

export function updateProxyGroup(
  profileId: number,
  itemId: number,
  input: { name: string; type: ProxyGroupType; config: JsonObject }
): ProxyGroup {
  ensureInitialized();
  return transaction((db) => {
    const current = db
      .prepare('SELECT * FROM proxy_groups WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!current) throw new HttpError(404, 'Strategy group not found');
    assertUniqueName(db, 'proxy_groups', profileId, input.name, itemId);
    assertPolicyNameAvailable(
      db,
      profileId,
      input.name,
      'proxy-groups',
      itemId
    );
    const oldName = String(current.name);
    db.prepare(
      'UPDATE proxy_groups SET name = ?, type = ?, config_ciphertext = ? WHERE id = ?'
    ).run(input.name, input.type, encryptJson(input.config), itemId);
    if (oldName !== input.name) {
      rewriteRenamedResource(
        db,
        profileId,
        'proxy-groups',
        oldName,
        input.name
      );
    }
    recordRevision(db, profileId);
    return mapProxyGroup(
      db.prepare('SELECT * FROM proxy_groups WHERE id = ?').get(itemId) as DbRow
    );
  });
}

export function deleteProxyGroup(profileId: number, itemId: number): void {
  ensureInitialized();
  transaction((db) => {
    const row = db
      .prepare('SELECT * FROM proxy_groups WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!row) throw new HttpError(404, 'Strategy group not found');
    assertNoReferences(
      snapshotFromDb(db, profileId),
      'proxy-groups',
      String(row.name)
    );
    db.prepare('DELETE FROM proxy_groups WHERE id = ?').run(itemId);
    recordRevision(db, profileId);
  });
}

export function createRuleProvider(
  profileId: number,
  input: {
    name: string;
    displayName?: string;
    behavior: string;
    providerType: RuleProviderType;
    config: JsonObject;
    entries: string[];
  }
): RuleProvider {
  ensureInitialized();
  return transaction((db) => {
    getProfileRow(db, profileId);
    assertUniqueName(db, 'rule_providers', profileId, input.name);
    const order = nextSortOrder(db, 'rule_providers', profileId);
    const result = db
      .prepare(
        `INSERT INTO rule_providers
         (profile_id, name, display_name, behavior, provider_type, config_ciphertext, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        input.name,
        input.displayName?.trim() || '',
        input.behavior,
        input.providerType,
        encryptJson(input.config),
        order
      );
    const providerId = Number(result.lastInsertRowid);
    input.entries.forEach((entry, index) => {
      db.prepare(
        'INSERT INTO rule_provider_entries (provider_id, value, sort_order) VALUES (?, ?, ?)'
      ).run(providerId, entry, index + 1);
    });
    recordRevision(db, profileId);
    return mapRuleProvider(
      db
        .prepare('SELECT * FROM rule_providers WHERE id = ?')
        .get(providerId) as DbRow,
      listRuleEntries(db, providerId)
    );
  });
}

export function updateRuleProvider(
  profileId: number,
  itemId: number,
  input: {
    name: string;
    displayName?: string;
    behavior: string;
    providerType: RuleProviderType;
    config: JsonObject;
    entries: string[];
  }
): RuleProvider {
  ensureInitialized();
  return transaction((db) => {
    const current = db
      .prepare('SELECT * FROM rule_providers WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!current) throw new HttpError(404, 'Rule provider not found');
    assertUniqueName(db, 'rule_providers', profileId, input.name, itemId);
    const oldName = String(current.name);
    db.prepare(
      `UPDATE rule_providers
       SET name = ?, display_name = COALESCE(?, display_name), behavior = ?, provider_type = ?, config_ciphertext = ? WHERE id = ?`
    ).run(
      input.name,
      input.displayName === undefined ? null : input.displayName.trim(),
      input.behavior,
      input.providerType,
      encryptJson(input.config),
      itemId
    );
    db.prepare('DELETE FROM rule_provider_entries WHERE provider_id = ?').run(
      itemId
    );
    input.entries.forEach((entry, index) => {
      db.prepare(
        'INSERT INTO rule_provider_entries (provider_id, value, sort_order) VALUES (?, ?, ?)'
      ).run(itemId, entry, index + 1);
    });
    if (oldName !== input.name) {
      rewriteRenamedResource(
        db,
        profileId,
        'rule-providers',
        oldName,
        input.name
      );
    }
    recordRevision(db, profileId);
    return mapRuleProvider(
      db
        .prepare('SELECT * FROM rule_providers WHERE id = ?')
        .get(itemId) as DbRow,
      listRuleEntries(db, itemId)
    );
  });
}

export function deleteRuleProvider(profileId: number, itemId: number): void {
  ensureInitialized();
  transaction((db) => {
    const row = db
      .prepare('SELECT * FROM rule_providers WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!row) throw new HttpError(404, 'Rule provider not found');
    assertNoReferences(
      snapshotFromDb(db, profileId),
      'rule-providers',
      String(row.name)
    );
    db.prepare('DELETE FROM rule_providers WHERE id = ?').run(itemId);
    recordRevision(db, profileId);
  });
}

function ruleProviderBelongsToProfile(
  db: Database.Database,
  profileId: number,
  providerId: number
): void {
  const row = db
    .prepare('SELECT id FROM rule_providers WHERE id = ? AND profile_id = ?')
    .get(providerId, profileId);
  if (!row) throw new HttpError(404, 'Rule provider not found');
}

function renumberProviderEntries(
  db: Database.Database,
  providerId: number,
  ids: number[]
): void {
  db.prepare(
    'UPDATE rule_provider_entries SET sort_order = sort_order + 1000000 WHERE provider_id = ?'
  ).run(providerId);
  ids.forEach((id, index) => {
    db.prepare(
      'UPDATE rule_provider_entries SET sort_order = ? WHERE id = ? AND provider_id = ?'
    ).run(index + 1, id, providerId);
  });
}

export function createRuleProviderEntry(
  profileId: number,
  providerId: number,
  input: { value: string; position?: number }
): RuleProviderEntry {
  ensureInitialized();
  return transaction((db) => {
    ruleProviderBelongsToProfile(db, profileId, providerId);
    const value = input.value.trim();
    if (!value) throw new HttpError(400, 'Rule provider entry cannot be empty');
    const ids = listRuleEntries(db, providerId).map((entry) => entry.id);
    const position = Math.max(
      1,
      Math.min(input.position || ids.length + 1, ids.length + 1)
    );
    const result = db
      .prepare(
        'INSERT INTO rule_provider_entries (provider_id, value, sort_order) VALUES (?, ?, ?)'
      )
      .run(providerId, value, ids.length + 1000001);
    const id = Number(result.lastInsertRowid);
    ids.splice(position - 1, 0, id);
    renumberProviderEntries(db, providerId, ids);
    recordRevision(db, profileId);
    return {
      id,
      value,
      sortOrder: position
    };
  });
}

export function updateRuleProviderEntry(
  profileId: number,
  providerId: number,
  entryId: number,
  input: { value: string; position?: number }
): RuleProviderEntry {
  ensureInitialized();
  return transaction((db) => {
    ruleProviderBelongsToProfile(db, profileId, providerId);
    const current = db
      .prepare(
        'SELECT id FROM rule_provider_entries WHERE id = ? AND provider_id = ?'
      )
      .get(entryId, providerId);
    if (!current) throw new HttpError(404, 'Rule provider entry not found');
    const value = input.value.trim();
    if (!value) throw new HttpError(400, 'Rule provider entry cannot be empty');
    db.prepare('UPDATE rule_provider_entries SET value = ? WHERE id = ?').run(
      value,
      entryId
    );
    const ids = listRuleEntries(db, providerId).map((entry) => entry.id);
    if (input.position !== undefined) {
      ids.splice(ids.indexOf(entryId), 1);
      ids.splice(
        Math.max(0, Math.min(input.position - 1, ids.length)),
        0,
        entryId
      );
      renumberProviderEntries(db, providerId, ids);
    }
    recordRevision(db, profileId);
    const row = db
      .prepare(
        'SELECT id, value, sort_order FROM rule_provider_entries WHERE id = ?'
      )
      .get(entryId) as DbRow;
    return {
      id: Number(row.id),
      value: String(row.value),
      sortOrder: Number(row.sort_order)
    };
  });
}

export function deleteRuleProviderEntry(
  profileId: number,
  providerId: number,
  entryId: number
): void {
  ensureInitialized();
  transaction((db) => {
    ruleProviderBelongsToProfile(db, profileId, providerId);
    const deleted = db
      .prepare(
        'DELETE FROM rule_provider_entries WHERE id = ? AND provider_id = ?'
      )
      .run(entryId, providerId);
    if (!deleted.changes)
      throw new HttpError(404, 'Rule provider entry not found');
    const ids = listRuleEntries(db, providerId).map((entry) => entry.id);
    renumberProviderEntries(db, providerId, ids);
    recordRevision(db, profileId);
  });
}

function terminalRule(rules: StashRule[]): StashRule {
  const enabled = rules.filter((rule) => rule.enabled);
  const terminal = enabled.at(-1);
  const matches = rules.filter((rule) => rule.type === 'MATCH');
  if (matches.length !== 1 || !terminal || terminal.type !== 'MATCH') {
    throw new HttpError(409, 'Exactly one enabled MATCH rule must remain last');
  }
  return terminal;
}

function renumberRules(
  db: Database.Database,
  profileId: number,
  ids: number[]
): void {
  db.prepare(
    'UPDATE rules SET priority = priority + 1000000 WHERE profile_id = ?'
  ).run(profileId);
  ids.forEach((id, index) => {
    db.prepare(
      'UPDATE rules SET priority = ? WHERE id = ? AND profile_id = ?'
    ).run(index + 1, id, profileId);
  });
}

export function createRule(
  profileId: number,
  input: {
    type: string;
    payload?: string;
    policy: string;
    options?: string[];
    enabled?: boolean;
    note?: string;
    priority?: number;
  }
): StashRule {
  ensureInitialized();
  return transaction((db) => {
    getProfileRow(db, profileId);
    const current = snapshotFromDb(db, profileId);
    const terminal = terminalRule(current.rules);
    const rule = normalizeRuleInput(input);
    if (rule.type === 'MATCH') {
      throw new HttpError(409, 'A terminal MATCH rule already exists');
    }
    const ids = current.rules
      .map((item) => item.id)
      .filter((id) => id !== terminal.id);
    const order = db
      .prepare(
        `INSERT INTO rules
        (profile_id, priority, type, payload, policy, options_json, enabled, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        current.rules.length + 1,
        rule.type,
        rule.payload,
        rule.policy,
        JSON.stringify(rule.options),
        Number(rule.enabled),
        rule.note
      );
    const id = Number(order.lastInsertRowid);
    const insertAt = Math.max(
      0,
      Math.min((input.priority || terminal.priority) - 1, ids.length)
    );
    ids.splice(insertAt, 0, id);
    ids.push(terminal.id);
    renumberRules(db, profileId, ids);
    recordRevision(db, profileId);
    return mapRule(
      db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as DbRow
    );
  });
}

export function updateRule(
  profileId: number,
  itemId: number,
  input: {
    type: string;
    payload?: string;
    policy: string;
    options?: string[];
    enabled?: boolean;
    note?: string;
    priority?: number;
  }
): StashRule {
  ensureInitialized();
  return transaction((db) => {
    const currentRow = db
      .prepare('SELECT * FROM rules WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!currentRow) throw new HttpError(404, 'Rule not found');
    const currentSnapshot = snapshotFromDb(db, profileId);
    const terminal = terminalRule(currentSnapshot.rules);
    const rule = normalizeRuleInput(input);
    const existing = currentSnapshot.rules.find((item) => item.id === itemId);
    if (!existing) throw new HttpError(404, 'Rule not found');
    if (existing.type === 'MATCH') {
      if (rule.type !== 'MATCH' || !rule.enabled) {
        throw new HttpError(
          409,
          'The terminal MATCH rule cannot be converted or disabled'
        );
      }
      if (input.priority && input.priority !== existing.priority) {
        throw new HttpError(409, 'The terminal MATCH rule must remain last');
      }
    } else if (rule.type === 'MATCH') {
      throw new HttpError(409, 'A terminal MATCH rule already exists');
    }
    db.prepare(
      `UPDATE rules
       SET type = ?, payload = ?, policy = ?, options_json = ?, enabled = ?, note = ?
       WHERE id = ?`
    ).run(
      rule.type,
      rule.payload,
      rule.policy,
      JSON.stringify(rule.options),
      Number(rule.enabled),
      rule.note,
      itemId
    );
    if (input.priority && existing.type !== 'MATCH') {
      const ids = currentSnapshot.rules
        .map((item) => item.id)
        .filter((id) => id !== itemId && id !== terminal.id);
      const insertAt = Math.max(0, Math.min(input.priority - 1, ids.length));
      ids.splice(insertAt, 0, itemId);
      ids.push(terminal.id);
      renumberRules(db, profileId, ids);
    }
    recordRevision(db, profileId);
    return mapRule(
      db.prepare('SELECT * FROM rules WHERE id = ?').get(itemId) as DbRow
    );
  });
}

export function deleteRule(profileId: number, itemId: number): void {
  ensureInitialized();
  transaction((db) => {
    const row = db
      .prepare('SELECT * FROM rules WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!row) throw new HttpError(404, 'Rule not found');
    if (String(row.type) === 'MATCH') {
      throw new HttpError(409, 'The terminal MATCH rule cannot be deleted');
    }
    db.prepare('DELETE FROM rules WHERE id = ?').run(itemId);
    const ids = (
      db
        .prepare(
          'SELECT id FROM rules WHERE profile_id = ? ORDER BY priority, id'
        )
        .all(profileId) as DbRow[]
    ).map((item) => Number(item.id));
    renumberRules(db, profileId, ids);
    recordRevision(db, profileId);
  });
}

export function reorderRules(profileId: number, ids: number[]): StashRule[] {
  ensureInitialized();
  return transaction((db) => {
    const snapshot = snapshotFromDb(db, profileId);
    const terminal = terminalRule(snapshot.rules);
    const currentIds = snapshot.rules.map((rule) => rule.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== currentIds.length ||
      ids.some((id) => !currentIds.includes(id)) ||
      ids.at(-1) !== terminal.id
    ) {
      throw new HttpError(
        409,
        'Order must include every rule once and end with MATCH'
      );
    }
    renumberRules(db, profileId, ids);
    recordRevision(db, profileId);
    return snapshotFromDb(db, profileId).rules;
  });
}

export function createHost(
  profileId: number,
  input: { pattern: string; value: string }
): HostEntry {
  ensureInitialized();
  return transaction((db) => {
    getProfileRow(db, profileId);
    const exists = db
      .prepare('SELECT id FROM hosts WHERE profile_id = ? AND pattern = ?')
      .get(profileId, input.pattern);
    if (exists) throw new HttpError(409, 'Host pattern already exists');
    const order = nextSortOrder(db, 'hosts', profileId);
    const result = db
      .prepare(
        'INSERT INTO hosts (profile_id, pattern, value, sort_order) VALUES (?, ?, ?, ?)'
      )
      .run(profileId, input.pattern, input.value, order);
    recordRevision(db, profileId);
    return mapHost(
      db
        .prepare('SELECT * FROM hosts WHERE id = ?')
        .get(result.lastInsertRowid) as DbRow
    );
  });
}

export function updateHost(
  profileId: number,
  itemId: number,
  input: { pattern: string; value: string }
): HostEntry {
  ensureInitialized();
  return transaction((db) => {
    const exists = db
      .prepare(
        'SELECT id FROM hosts WHERE profile_id = ? AND pattern = ? AND id <> ?'
      )
      .get(profileId, input.pattern, itemId);
    if (exists) throw new HttpError(409, 'Host pattern already exists');
    const changed = db
      .prepare(
        'UPDATE hosts SET pattern = ?, value = ? WHERE id = ? AND profile_id = ?'
      )
      .run(input.pattern, input.value, itemId, profileId);
    if (!changed.changes) throw new HttpError(404, 'Host entry not found');
    recordRevision(db, profileId);
    return mapHost(
      db.prepare('SELECT * FROM hosts WHERE id = ?').get(itemId) as DbRow
    );
  });
}

export function deleteHost(profileId: number, itemId: number): void {
  ensureInitialized();
  transaction((db) => {
    const changed = db
      .prepare('DELETE FROM hosts WHERE id = ? AND profile_id = ?')
      .run(itemId, profileId);
    if (!changed.changes) throw new HttpError(404, 'Host entry not found');
    recordRevision(db, profileId);
  });
}

export function replaceAdvancedSections(
  profileId: number,
  sections: Array<{ key: string; value: JsonValue }>
): AdvancedSection[] {
  ensureInitialized();
  return transaction((db) => {
    getProfileRow(db, profileId);
    const seen = new Set<string>();
    for (const section of sections) {
      if (RESERVED_TOP_LEVEL_KEYS.has(section.key)) {
        throw new HttpError(
          400,
          `Top-level section “${section.key}” is managed by a dedicated resource`
        );
      }
      if (seen.has(section.key)) {
        throw new HttpError(400, `Duplicate advanced section: ${section.key}`);
      }
      seen.add(section.key);
    }
    db.prepare('DELETE FROM advanced_sections WHERE profile_id = ?').run(
      profileId
    );
    const insert = db.prepare(
      `INSERT INTO advanced_sections
         (profile_id, section_key, value_ciphertext, sort_order)
       VALUES (?, ?, ?, ?)`
    );
    sections.forEach((section, index) => {
      insert.run(profileId, section.key, encryptJson(section.value), index + 1);
    });
    recordRevision(db, profileId);
    return snapshotFromDb(db, profileId).advancedSections;
  });
}

export function importYaml(profileId: number, yamlText: string): Snapshot {
  ensureInitialized();
  const document = parseYamlDocument(yamlText);
  return transaction((db) => {
    replaceProfileResources(db, profileId, document);
    recordRevision(db, profileId);
    return publicSnapshot(snapshotFromDb(db, profileId));
  });
}

export function listRevisions(
  profileId: number,
  options: { limit?: number; before?: number } = {}
): {
  items: Array<{ id: number; revision: number; createdAt: string }>;
  nextCursor: number | null;
} {
  ensureInitialized();
  getProfileRow(getDb(), profileId);
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
  const before = options.before ?? null;
  const rows =
    before === null
      ? (getDb()
          .prepare(
            `SELECT id, revision, created_at
           FROM revisions WHERE profile_id = ?
           ORDER BY revision DESC LIMIT ?`
          )
          .all(profileId, limit + 1) as DbRow[])
      : (getDb()
          .prepare(
            `SELECT id, revision, created_at
           FROM revisions WHERE profile_id = ? AND revision < ?
           ORDER BY revision DESC LIMIT ?`
          )
          .all(profileId, before, limit + 1) as DbRow[]);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => {
    const item = row as DbRow;
    return {
      id: Number(item.id),
      revision: Number(item.revision),
      createdAt: String(item.created_at)
    };
  });
  return {
    items,
    nextCursor: hasMore ? (items.at(-1)?.revision ?? null) : null
  };
}

export function restoreRevision(profileId: number, revision: number): Snapshot {
  ensureInitialized();
  return transaction((db) => {
    const row = db
      .prepare(
        'SELECT config_ciphertext FROM revisions WHERE profile_id = ? AND revision = ?'
      )
      .get(profileId, revision) as DbRow | undefined;
    if (!row) throw new HttpError(404, 'Revision not found');
    const snapshot = decryptJson<Snapshot>(String(row.config_ciphertext));
    replaceProfileResources(db, profileId, {
      mode: snapshot.profile.mode,
      targetPlatform: snapshot.profile.targetPlatform,
      logLevel: snapshot.profile.logLevel,
      ipv6: snapshot.profile.ipv6,
      settings: snapshot.profile.settings,
      proxies: snapshot.proxies.map((item) => ({
        name: item.name,
        type: item.type,
        config: item.config
      })),
      proxyProviders: snapshot.proxyProviders.map((item) => ({
        name: item.name,
        config: item.config,
        requiresUrl: item.requiresUrl
      })),
      proxyGroups: snapshot.proxyGroups.map((item) => ({
        name: item.name,
        type: item.type,
        config: item.config
      })),
      ruleProviders: snapshot.ruleProviders.map((item) => ({
        name: item.name,
        displayName: item.displayName,
        behavior: item.behavior,
        providerType: item.providerType,
        config: item.config,
        entries: item.entries.map((entry) => entry.value)
      })),
      rules: snapshot.rules.map((item) => ({
        type: item.type,
        payload: item.payload,
        policy: item.policy,
        options: item.options,
        enabled: item.enabled,
        note: item.note
      })),
      hosts: snapshot.hosts.map((item) => ({
        pattern: item.pattern,
        value: item.value
      })),
      advancedSections: snapshot.advancedSections.map((item) => ({
        key: item.key,
        value: item.value
      }))
    });
    recordRevision(db, profileId);
    return publicSnapshot(snapshotFromDb(db, profileId));
  });
}

export function resourceUsage(profileId: number): Record<string, number> {
  const snapshot = getSnapshot(profileId);
  return {
    proxies: snapshot.proxies.length,
    proxyProviders: snapshot.proxyProviders.length,
    proxyGroups: snapshot.proxyGroups.length,
    ruleProviders: snapshot.ruleProviders.length,
    rules: snapshot.rules.length,
    hosts: snapshot.hosts.length,
    advancedSections: snapshot.advancedSections.length
  };
}
