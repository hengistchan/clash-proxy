import type Database from 'better-sqlite3';

import { transaction } from './db';
import { encryptJson } from './crypto';
import { HttpError } from './http';
import {
  publicRuleProvider,
  ruleProviderConfig,
  type RuleProviderInput
} from './rule-provider-source';
import type { RuleProvider, RuleProviderEntry } from './types';
import {
  assertUniqueName,
  decryptObject,
  getProfileRow,
  listRuleEntries,
  mapRuleProvider,
  nextSortOrder,
  snapshotFromDb
} from './repository-shared';
import { assertNoReferences, rewriteRenamedResource } from './resource-references';

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

export function createRuleProviderRepository({
  ensureInitialized,
  recordRevision
}: {
  ensureInitialized: () => void;
  recordRevision: (db: Database.Database, profileId: number) => number;
}) {
  function createRuleProvider(
    profileId: number,
    input: RuleProviderInput
  ): RuleProvider {
    ensureInitialized();
    return transaction((db) => {
      getProfileRow(db, profileId);
      assertUniqueName(db, 'rule_providers', profileId, input.name);
      const config = ruleProviderConfig(input);
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
          encryptJson(config),
          order
        );
      const providerId = Number(result.lastInsertRowid);
      input.entries.forEach((entry, index) => {
        db.prepare(
          'INSERT INTO rule_provider_entries (provider_id, value, sort_order) VALUES (?, ?, ?)'
        ).run(providerId, entry, index + 1);
      });
      recordRevision(db, profileId);
      return publicRuleProvider(
        mapRuleProvider(
          db
            .prepare('SELECT * FROM rule_providers WHERE id = ?')
            .get(providerId) as Record<string, unknown>,
          listRuleEntries(db, providerId)
        )
      );
    });
  }

  function updateRuleProvider(
    profileId: number,
    itemId: number,
    input: RuleProviderInput
  ): RuleProvider {
    ensureInitialized();
    return transaction((db) => {
      const current = db
        .prepare('SELECT * FROM rule_providers WHERE id = ? AND profile_id = ?')
        .get(itemId, profileId) as Record<string, unknown> | undefined;
      if (!current) throw new HttpError(404, 'Rule provider not found');
      assertUniqueName(db, 'rule_providers', profileId, input.name, itemId);
      const oldName = String(current.name);
      const config = ruleProviderConfig(
        input,
        input.providerType === String(current.provider_type)
          ? decryptObject(current.config_ciphertext)
          : {}
      );
      db.prepare(
        `UPDATE rule_providers
       SET name = ?, display_name = COALESCE(?, display_name), behavior = ?, provider_type = ?, config_ciphertext = ? WHERE id = ?`
      ).run(
        input.name,
        input.displayName === undefined ? null : input.displayName.trim(),
        input.behavior,
        input.providerType,
        encryptJson(config),
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
      return publicRuleProvider(
        mapRuleProvider(
          db
            .prepare('SELECT * FROM rule_providers WHERE id = ?')
            .get(itemId) as Record<string, unknown>,
          listRuleEntries(db, itemId)
        )
      );
    });
  }

  function deleteRuleProvider(profileId: number, itemId: number): void {
    ensureInitialized();
    transaction((db) => {
      const row = db
        .prepare('SELECT * FROM rule_providers WHERE id = ? AND profile_id = ?')
        .get(itemId, profileId) as Record<string, unknown> | undefined;
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

  function createRuleProviderEntry(
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

  function updateRuleProviderEntry(
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
      db.prepare(
        'UPDATE rule_provider_entries SET value = ? WHERE id = ?'
      ).run(value, entryId);
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
        .get(entryId) as Record<string, unknown>;
      return {
        id: Number(row.id),
        value: String(row.value),
        sortOrder: Number(row.sort_order)
      };
    });
  }

  function deleteRuleProviderEntry(
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

  return {
    createRuleProvider,
    updateRuleProvider,
    deleteRuleProvider,
    createRuleProviderEntry,
    updateRuleProviderEntry,
    deleteRuleProviderEntry
  };
}
