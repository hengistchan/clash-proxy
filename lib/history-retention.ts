import type Database from 'better-sqlite3';
import { protectedCompiledRevisions } from './compilation';

export function revisionRetentionLimit(): number {
  const text = process.env.STASH_REVISION_LIMIT?.trim();
  if (!text) return 200;
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 10 || value > 10_000) {
    throw new Error('STASH_REVISION_LIMIT must be an integer between 10 and 10000');
  }
  return value;
}

export function revisionRetentionStatus(db: Database.Database, profileId: number) {
  const row = db.prepare('SELECT COUNT(*) AS count, MIN(revision) AS oldest FROM revisions WHERE profile_id = ?').get(profileId) as { count: number; oldest: number | null };
  return { retentionLimit: revisionRetentionLimit(), retainedCount: row.count, oldestRevision: row.oldest };
}

/** Called in the same write transaction after compiling the new revision. */
export function pruneRevisionHistory(db: Database.Database, profileId: number): number {
  const limit = revisionRetentionLimit();
  const profile = db.prepare('SELECT revision FROM profiles WHERE id = ?').get(profileId) as { revision: number } | undefined;
  if (!profile) return 0;
  const published = db.prepare('SELECT DISTINCT revision FROM target_publications WHERE profile_id = ?')
    .all(profileId) as Array<{ revision: number }>;
  const protectedRevisions = [...new Set([profile.revision, ...protectedCompiledRevisions(db, profileId), ...published.map(row => row.revision)])];
  return db.prepare(`DELETE FROM revisions
    WHERE profile_id = ? AND revision NOT IN (${protectedRevisions.map(() => '?').join(', ')})
      AND revision NOT IN (SELECT revision FROM revisions WHERE profile_id = ? ORDER BY revision DESC LIMIT ?)`)
    .run(profileId, ...protectedRevisions, profileId, limit).changes;
}
