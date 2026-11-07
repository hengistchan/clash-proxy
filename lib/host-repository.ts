import type Database from 'better-sqlite3';

import { transaction } from './db';
import { HttpError } from './http';
import type { HostEntry } from './types';
import { getProfileRow, mapHost, nextSortOrder } from './repository-shared';

export function createHostRepository({
  ensureInitialized,
  recordRevision
}: {
  ensureInitialized: () => void;
  recordRevision: (db: Database.Database, profileId: number) => number;
}) {
  function createHost(
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
          .get(result.lastInsertRowid) as Record<string, unknown>
      );
    });
  }

  function updateHost(
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
        db.prepare('SELECT * FROM hosts WHERE id = ?').get(itemId) as Record<
          string,
          unknown
        >
      );
    });
  }

  function deleteHost(profileId: number, itemId: number): void {
    ensureInitialized();
    transaction((db) => {
      const changed = db
        .prepare('DELETE FROM hosts WHERE id = ? AND profile_id = ?')
        .run(itemId, profileId);
      if (!changed.changes) throw new HttpError(404, 'Host entry not found');
      recordRevision(db, profileId);
    });
  }

  return { createHost, updateHost, deleteHost };
}
