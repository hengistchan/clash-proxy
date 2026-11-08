import type Database from 'better-sqlite3';
import { projectMatchType, storeMatchType, upgradeResource, type StoredResourceKind } from './config-storage-model';

const resources = [
  ['profiles', 'settings_ciphertext', 'settings'],
  ['proxies', 'config_ciphertext', 'node'],
  ['proxy_providers', 'config_ciphertext', 'nodeSource'],
  ['proxy_groups', 'config_ciphertext', 'policyGroup'],
  ['rule_providers', 'config_ciphertext', 'ruleSource'],
  ['advanced_sections', 'value_ciphertext', 'extension']
] as const satisfies ReadonlyArray<readonly [string, string, StoredResourceKind]>;

/** Live data changes in a single SQLite migration. History remains readable in
 * both formats so upgrading does not decrypt and rewrite every old revision. */
export function migrateConfigStorageModel(db: Database.Database) {
  for (const [table, column, kind] of resources) {
    const read = db.prepare(`SELECT id, ${column} AS value FROM ${table} WHERE id > ? ORDER BY id LIMIT 64`);
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
    let after = 0;
    for (;;) {
      const rows = read.all(after) as Array<{ id: number; value: string }>;
      if (!rows.length) break;
      for (const row of rows) {
        const upgraded = upgradeResource(kind, row.value);
        if (upgraded !== row.value) update.run(upgraded, row.id);
        after = row.id;
      }
    }
  }
  const updateRule = db.prepare('UPDATE rules SET type = ? WHERE type = ?');
  for (const { type } of db.prepare('SELECT DISTINCT type FROM rules').all() as { type: string }[]) {
    const canonical = storeMatchType(projectMatchType(type));
    if (canonical !== type) updateRule.run(canonical, type);
  }
}
