import type Database from 'better-sqlite3';
import { encryptJson } from './crypto';
import { reconcileServedSources } from './managed-source-health';
import { compileMihomo } from './mihomo-export';
import { deliveryMode, managedSources, mihomoCandidate } from './target-publication-store';
import type { JsonValue, Snapshot, ValidationIssue } from './types';

const COMPILER_VERSION = 1;

export function mihomoCompiledRevision(db: Database.Database, profileId: number) {
  return mihomoCandidate(db, profileId)?.revision ?? null;
}

export function mihomoCheck(db: Database.Database, profileId: number) {
  return db.prepare('SELECT checked_revision, compiler_version, issues_json FROM mihomo_compilations WHERE profile_id = ?')
    .get(profileId) as { checked_revision: number; compiler_version: number; issues_json: string } | undefined;
}

function upToDate(check: ReturnType<typeof mihomoCheck>, revision: number) {
  return check && (check.checked_revision > revision ||
    (check.checked_revision === revision && check.compiler_version >= COMPILER_VERSION));
}

export function mihomoIssues(db: Database.Database, profileId: number): ValidationIssue[] {
  const check = mihomoCheck(db, profileId);
  return check ? JSON.parse(check.issues_json) : [];
}

export function refreshMihomoConfig(db: Database.Database, snapshot: Snapshot) {
  const { id, revision } = snapshot.profile;
  if (upToDate(mihomoCheck(db, id), revision)) return;
  const { artifact, issues } = compileMihomo(snapshot);
  db.transaction(() => {
    const currentRevision = db.prepare('SELECT revision FROM profiles WHERE id = ?').pluck().get(id);
    if (currentRevision !== revision || upToDate(mihomoCheck(db, id), revision)) return;
    const before = artifact && !deliveryMode(db, id, 'mihomo') ? managedSources(mihomoCandidate(db, id)) : null;
    db.prepare(`INSERT INTO mihomo_compilations
        (profile_id, checked_revision, compiler_version, issues_json, revision, artifact_ciphertext, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        checked_revision = excluded.checked_revision,
        compiler_version = excluded.compiler_version,
        issues_json = excluded.issues_json,
        revision = COALESCE(excluded.revision, mihomo_compilations.revision),
        artifact_ciphertext = COALESCE(excluded.artifact_ciphertext, mihomo_compilations.artifact_ciphertext),
        created_at = COALESCE(excluded.created_at, mihomo_compilations.created_at)`).run(
      id, revision, COMPILER_VERSION, JSON.stringify(issues), artifact ? revision : null,
      artifact ? encryptJson(artifact as unknown as JsonValue) : null, artifact ? new Date().toISOString() : null
    );
    if (before) reconcileServedSources(db, id, before, artifact?.proxyRewrites?.sources ?? [], 'mihomo');
  }).immediate();
}
