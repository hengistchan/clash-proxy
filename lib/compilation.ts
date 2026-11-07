import type Database from 'better-sqlite3';
import { decryptJson, encryptJson } from './crypto';
import { exportProfile, type ExportResult } from './exporter';
import { CONFIG_COMPILER_VERSION } from './artifact-semantics';
import { HttpError } from './http';
import type { JsonValue, Snapshot } from './types';

// A failed draft never replaces the last successfully compiled artifact.
export function refreshCompiledConfig(
  db: Database.Database,
  snapshot: Snapshot
): void {
  const current = db
    .prepare('SELECT revision, artifact_ciphertext FROM compiled_configs WHERE profile_id = ?')
    .get(snapshot.profile.id) as { revision: number; artifact_ciphertext: string } | undefined;
  if (current && (current.revision > snapshot.profile.revision || (current.revision === snapshot.profile.revision && decryptJson<ExportResult>(current.artifact_ciphertext).compilerVersion === CONFIG_COMPILER_VERSION))) return;
  try {
    const artifact = exportProfile(snapshot);
    db.prepare(
      `INSERT INTO compiled_configs (profile_id, revision, artifact_ciphertext, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET
      revision = excluded.revision, artifact_ciphertext = excluded.artifact_ciphertext,
      created_at = excluded.created_at
      WHERE excluded.revision >= compiled_configs.revision`
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
