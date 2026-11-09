import type Database from 'better-sqlite3';
import { decryptJson, encryptJson } from './crypto';
import { exportProfile, type ExportResult } from './exporter';
import { CONFIG_COMPILER_VERSION } from './artifact-semantics';
import { managedSources, stashCandidate, deliveryMode } from './target-publication-store';
import { reconcileServedSources } from './managed-source-health';
import { HttpError } from './http';
import type { JsonValue, Snapshot } from './types';

export function stashCompiledRevision(db: Database.Database, profileId: number) {
  const row = db.prepare('SELECT revision FROM compiled_configs WHERE profile_id = ?').get(profileId) as { revision: number } | undefined;
  return row?.revision ?? null;
}

export function refreshStashConfig(
  db: Database.Database,
  snapshot: Snapshot
): void {
  const current = stashCandidate(db, snapshot.profile.id);
  if (current && (current.revision > snapshot.profile.revision || (current.revision === snapshot.profile.revision && decryptJson<ExportResult>(current.artifact_ciphertext).compilerVersion === CONFIG_COMPILER_VERSION))) return;
  try {
    const artifact = exportProfile(snapshot);
    db.transaction(() => {
      // A status read may have compiled outside the write lock; do not publish a stale snapshot.
      if (db.prepare('SELECT revision FROM profiles WHERE id = ?').pluck().get(snapshot.profile.id) !== snapshot.profile.revision) return;
      const previous = stashCandidate(db, snapshot.profile.id);
      const saved = db.prepare(
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
      if (!saved.changes) return;
      if (!deliveryMode(db, snapshot.profile.id, 'stash')) {
        reconcileServedSources(db, snapshot.profile.id, managedSources(previous), artifact.proxyRewrites?.sources ?? []);
      }
    }).immediate();
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 409)) throw error;
  }
}
