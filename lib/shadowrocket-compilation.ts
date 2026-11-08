import type Database from 'better-sqlite3';
import { encryptJson } from './crypto';
import { compileShadowrocket, SHADOWROCKET_COMPILER_VERSION, type ShadowrocketArtifact } from './shadowrocket';
import type { Snapshot, ValidationIssue } from './types';

export function refreshShadowrocketConfig(db: Database.Database, snapshot: Snapshot) {
  const { id, revision } = snapshot.profile;
  const previous = db.prepare('SELECT checked_revision, compiler_version FROM shadowrocket_compilations WHERE profile_id = ?')
    .get(id) as { checked_revision: number; compiler_version: number } | undefined;
  if (previous && (previous.checked_revision > revision ||
    (previous.checked_revision === revision && previous.compiler_version >= SHADOWROCKET_COMPILER_VERSION))) return;

  const { artifact, issues, sources } = compileShadowrocket(snapshot);
  // Record the new diagnostics independently of the last successful device artifact.
  db.prepare(`INSERT INTO shadowrocket_compilations
      (profile_id, checked_revision, compiler_version, issues_json, remote_sources, revision, artifact_version, artifact_ciphertext, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      checked_revision = excluded.checked_revision,
      compiler_version = excluded.compiler_version,
      issues_json = excluded.issues_json,
      remote_sources = excluded.remote_sources,
      remote_checked_at = NULL,
      revision = COALESCE(excluded.revision, shadowrocket_compilations.revision),
      artifact_version = COALESCE(excluded.artifact_version, shadowrocket_compilations.artifact_version),
      artifact_ciphertext = COALESCE(excluded.artifact_ciphertext, shadowrocket_compilations.artifact_ciphertext),
      created_at = COALESCE(excluded.created_at, shadowrocket_compilations.created_at)
    WHERE excluded.checked_revision > shadowrocket_compilations.checked_revision OR
      (excluded.checked_revision = shadowrocket_compilations.checked_revision AND
        excluded.compiler_version > shadowrocket_compilations.compiler_version)`).run(
    id, revision, SHADOWROCKET_COMPILER_VERSION, JSON.stringify(issues), Number(sources.length > 0),
    artifact ? revision : null, artifact ? SHADOWROCKET_COMPILER_VERSION : null,
    artifact ? encryptJson({ ...artifact }) : null, artifact ? new Date().toISOString() : null
  );
}

/** Discard slow upstream results when a different profile revision has since been saved. */
export function storeShadowrocketRefresh(
  db: Database.Database,
  profile: Snapshot['profile'],
  artifact: ShadowrocketArtifact | null,
  issues: ValidationIssue[]
) {
  db.prepare(`UPDATE shadowrocket_compilations SET
    remote_checked_at = ?, issues_json = ?,
    revision = COALESCE(?, revision), artifact_version = COALESCE(?, artifact_version),
    artifact_ciphertext = COALESCE(?, artifact_ciphertext), created_at = COALESCE(?, created_at)
    WHERE profile_id = ? AND checked_revision = ? AND compiler_version = ? AND remote_sources = 1
      AND EXISTS (SELECT 1 FROM profiles WHERE id = ? AND revision = ?)`)
    .run(Date.now(), JSON.stringify(issues), artifact ? profile.revision : null,
      artifact ? SHADOWROCKET_COMPILER_VERSION : null, artifact ? encryptJson({ ...artifact }) : null,
      artifact ? new Date().toISOString() : null, profile.id, profile.revision,
      SHADOWROCKET_COMPILER_VERSION, profile.id, profile.revision);
}
