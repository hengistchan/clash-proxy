import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { encryptJson } from './crypto';
import type { ImportedDocument } from './yaml-import';
import type { JsonObject } from './types';
import {
  decryptObject,
  getProfileRow,
  now
} from './repository-shared';

export function replaceProfileResources(
  db: Database.Database,
  profileId: number,
  document: ImportedDocument,
  options: { preserveExistingSources?: boolean } = {}
): void {
  getProfileRow(db, profileId);
  const touched = now();
  // Template imports may reuse existing source bindings. History restoration
  // must reproduce the snapshot, including intentionally missing credentials.
  const existingSources = new Map<string, JsonObject>(
    options.preserveExistingSources
      ? (
          db
            .prepare('SELECT * FROM proxy_providers WHERE profile_id = ?')
            .all(profileId) as Record<string, unknown>[]
        ).map((row) => [String(row.name), decryptObject(row.config_ciphertext)])
      : []
  );
  const existingRuleSetNames = new Map(
    (
      db
        .prepare(
          'SELECT name, display_name FROM rule_providers WHERE profile_id = ?'
        )
        .all(profileId) as Record<string, unknown>[]
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

export function seedTemplate(): string {
  const configured = process.env.STASH_TEMPLATE_DIR;
  const file = configured
    ? path.join(
        path.resolve(/*turbopackIgnore: true*/ configured),
        'Production.yaml'
      )
    : path.join(process.cwd(), 'examples', 'Production.yaml');
  return readFileSync(/*turbopackIgnore: true*/ file, 'utf8');
}
