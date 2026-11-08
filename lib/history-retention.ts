import type Database from 'better-sqlite3';

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
  const compiled = db.prepare('SELECT revision FROM compiled_configs WHERE profile_id = ?').get(profileId) as { revision: number } | undefined;
  const shadowrocket = db.prepare('SELECT revision FROM shadowrocket_compilations WHERE profile_id = ?').get(profileId) as { revision: number | null } | undefined;
  return db.prepare(`DELETE FROM revisions
    WHERE profile_id = ? AND revision NOT IN (?, ?, ?)
      AND revision NOT IN (SELECT revision FROM revisions WHERE profile_id = ? ORDER BY revision DESC LIMIT ?)`)
    .run(profileId, profile.revision, compiled?.revision ?? -1, shadowrocket?.revision ?? -1, profileId, limit).changes;
}
