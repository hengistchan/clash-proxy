import type Database from 'better-sqlite3';
import { encryptJson } from './crypto';
import { exportProfile } from './exporter';
import { HttpError } from './http';
import type { JsonValue, Snapshot } from './types';

// A failed draft never replaces the last successfully compiled artifact.
export function refreshCompiledConfig(
  db: Database.Database,
  snapshot: Snapshot
): void {
  const current = db
    .prepare('SELECT revision FROM compiled_configs WHERE profile_id = ?')
    .get(snapshot.profile.id) as { revision: number } | undefined;
  if (current && current.revision >= snapshot.profile.revision) return;
  try {
    const artifact = exportProfile(snapshot);
    db.prepare(
      `INSERT INTO compiled_configs (profile_id, revision, artifact_ciphertext, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET
      revision = excluded.revision, artifact_ciphertext = excluded.artifact_ciphertext,
      created_at = excluded.created_at
      WHERE excluded.revision > compiled_configs.revision`
    ).run(
      snapshot.profile.id,
      snapshot.profile.revision,
      encryptJson(artifact as unknown as JsonValue),
      new Date().toISOString()
    );
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 409)) throw error;
  }
}
