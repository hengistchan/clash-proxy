import type Database from 'better-sqlite3';
import type { ConfigTarget } from './config-targets';
import { decryptJson } from './crypto';
import type { ExportResult } from './exporter';

export interface ArtifactRecord {
  revision: number;
  artifact_ciphertext: string;
  created_at: string;
}

export interface Publication {
  id: number;
  revision: number;
  publishedAt: string;
}

export function deliveryMode(db: Database.Database, profileId: number, target: ConfigTarget) {
  return db.prepare('SELECT publication_id FROM target_delivery_modes WHERE profile_id = ? AND target = ?')
    .get(profileId, target) as { publication_id: number | null } | undefined;
}

export function publicationRecord(db: Database.Database, profileId: number, target: ConfigTarget, id: number | null) {
  if (id === null) return undefined;
  return db.prepare(`SELECT revision, artifact_ciphertext, published_at AS created_at
    FROM target_publications WHERE id = ? AND profile_id = ? AND target = ?`)
    .get(id, profileId, target) as ArtifactRecord | undefined;
}

export function publicationsFor(db: Database.Database, profileId: number, target: ConfigTarget) {
  return db.prepare(`SELECT id, revision, published_at AS publishedAt FROM target_publications
    WHERE profile_id = ? AND target = ? ORDER BY id DESC LIMIT 20`).all(profileId, target) as Publication[];
}

export function stashCandidate(db: Database.Database, profileId: number) {
  return db.prepare('SELECT revision, artifact_ciphertext, created_at FROM compiled_configs WHERE profile_id = ?')
    .get(profileId) as ArtifactRecord | undefined;
}

export function servedRecord(db: Database.Database, profileId: number, target: ConfigTarget) {
  const mode = deliveryMode(db, profileId, target);
  if (mode) return publicationRecord(db, profileId, target, mode.publication_id);
  if (target === 'stash') return stashCandidate(db, profileId);
  if (target === 'mihomo') return mihomoCandidate(db, profileId);
  return shadowrocketCandidate(db, profileId);
}

export function servedStashRecord(db: Database.Database, profileId: number) {
  return servedRecord(db, profileId, 'stash');
}

export function mihomoCandidate(db: Database.Database, profileId: number) {
  return db.prepare(`SELECT revision, artifact_ciphertext, created_at FROM mihomo_compilations
    WHERE profile_id = ? AND revision IS NOT NULL AND artifact_ciphertext IS NOT NULL`).get(profileId) as ArtifactRecord | undefined;
}

export function managedSources(record: ArtifactRecord | undefined) {
  return record ? decryptJson<ExportResult>(record.artifact_ciphertext).proxyRewrites?.sources ?? [] : [];
}

export function shadowrocketCandidate(db: Database.Database, profileId: number) {
  return db.prepare(`SELECT revision, artifact_ciphertext, created_at, artifact_version
    FROM shadowrocket_compilations WHERE profile_id = ? AND revision IS NOT NULL AND artifact_ciphertext IS NOT NULL`)
    .get(profileId) as (ArtifactRecord & { artifact_version: number }) | undefined;
}

export function publicationStatus(db: Database.Database, profileId: number, target: ConfigTarget) {
  const mode = deliveryMode(db, profileId, target);
  return { deliveryMode: mode ? 'manual' : 'auto', publicationId: mode?.publication_id ?? null } as const;
}
