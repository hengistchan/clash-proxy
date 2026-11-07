import type Database from 'better-sqlite3';

import { decryptJson } from './crypto';
import { HttpError } from './http';
import { mapRule } from './rule-repository';
import { publicRuleProvider } from './rule-provider-source';
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
  Snapshot
} from './types';

export type DbRow = Record<string, unknown>;

export function now(): string {
  return new Date().toISOString();
}

export function decryptObject(value: unknown): JsonObject {
  return decryptJson<JsonObject>(String(value || ''));
}

export function mapProfile(row: DbRow): Profile {
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

export function mapProxy(row: DbRow): ProxyNode {
  return {
    id: Number(row.id),
    name: String(row.name),
    type: String(row.type),
    config: decryptObject(row.config_ciphertext),
    sortOrder: Number(row.sort_order)
  };
}

export function mapProxyProvider(row: DbRow): ProxyProvider {
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

export function mapProxyGroup(row: DbRow): ProxyGroup {
  return {
    id: Number(row.id),
    name: String(row.name),
    type: String(row.type) as ProxyGroupType,
    config: decryptObject(row.config_ciphertext),
    sortOrder: Number(row.sort_order)
  };
}

export function mapRuleProvider(
  row: DbRow,
  entries: RuleProviderEntry[]
): RuleProvider {
  const config = decryptObject(row.config_ciphertext);
  const providerType = String(row.provider_type) as RuleProviderType;
  return {
    id: Number(row.id),
    name: String(row.name),
    displayName: String(row.display_name || ''),
    behavior: String(row.behavior),
    providerType,
    sourceConfigured:
      providerType === 'inline' ||
      (providerType === 'remote'
        ? typeof config.url === 'string' && Boolean(config.url.trim())
        : typeof config.path === 'string' && Boolean(config.path.trim())),
    headersConfigured: Boolean(
      config.headers && Object.keys(config.headers).length
    ),
    config,
    entries,
    sortOrder: Number(row.sort_order)
  };
}

export function mapHost(row: DbRow): HostEntry {
  return {
    id: Number(row.id),
    pattern: String(row.pattern),
    value: String(row.value),
    sortOrder: Number(row.sort_order)
  };
}

export function mapAdvanced(row: DbRow): AdvancedSection {
  return {
    id: Number(row.id),
    key: String(row.section_key),
    value: decryptJson<JsonValue>(String(row.value_ciphertext)),
    sortOrder: Number(row.sort_order)
  };
}

export function getProfileRow(
  db: Database.Database,
  profileId: number
): DbRow {
  const row = db
    .prepare('SELECT * FROM profiles WHERE id = ?')
    .get(profileId) as DbRow | undefined;
  if (!row) {
    throw new HttpError(404, 'Profile not found');
  }
  return row;
}

export function listRuleEntries(
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

export function snapshotFromDb(
  db: Database.Database,
  profileId: number
): Snapshot {
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

export function nextSortOrder(
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

export function assertProfileNameAvailable(
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

export function assertUniqueName(
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

export function assertPolicyNameAvailable(
  db: Database.Database,
  profileId: number,
  name: string,
  kind: 'proxies' | 'proxy-groups'
): void {
  // IDs are scoped to their table. Excluding the edited ID from the other
  // table can hide an unrelated resource that happens to have the same ID.
  const otherTable = kind === 'proxies' ? 'proxy_groups' : 'proxies';
  const collision = db
    .prepare(
      `SELECT id FROM ${otherTable} WHERE profile_id = ? AND name = ?`
    )
    .get(profileId, name);
  if (collision) {
    throw new HttpError(
      409,
      'Direct proxies and strategy groups must use unique policy names'
    );
  }
}

export function publicProvider(provider: ProxyProvider): ProxyProvider {
  const config = { ...provider.config };
  delete config.url;
  delete config.headers;
  return { ...provider, config };
}

export function publicSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    proxyProviders: snapshot.proxyProviders.map(publicProvider),
    ruleProviders: snapshot.ruleProviders.map(publicRuleProvider)
  };
}
