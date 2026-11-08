import type Database from 'better-sqlite3';
import { encryptRevision } from './config-storage-model';
import { refreshCompiledConfig } from './compilation';
import { pruneRevisionHistory } from './history-retention';
import type { Snapshot } from './types';

/** Persist the state, publish only valid output, then bound history in the same transaction. */
export function persistRevision(db: Database.Database, profileId: number, readSnapshot: () => Snapshot): number {
  const row = db.prepare('SELECT revision FROM profiles WHERE id = ?').get(profileId) as { revision: number };
  const nextRevision = row.revision + 1;
  const touched = new Date().toISOString();
  db.prepare('UPDATE profiles SET revision = ?, updated_at = ? WHERE id = ?').run(nextRevision, touched, profileId);
  const snapshot = readSnapshot();
  db.prepare('INSERT INTO revisions (profile_id, revision, config_ciphertext, created_at) VALUES (?, ?, ?, ?)')
    .run(profileId, nextRevision, encryptRevision(snapshot), touched);
  refreshCompiledConfig(db, snapshot);
  pruneRevisionHistory(db, profileId);
  return nextRevision;
}
