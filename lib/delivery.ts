import { createHash, randomBytes } from 'node:crypto';
import { getDb } from './db';
import { decryptJson, encryptJson } from './crypto';
import { refreshStashConfig } from './stash-compilation';
import { stashTargetIssues, type ExportResult } from './exporter';
import { getCompilationSnapshot } from './repository';
import { HttpError } from './http';
import { assertArtifactSemantics } from './artifact-semantics';

function artifactRow(profileId: number) {
  const snapshot = getCompilationSnapshot(profileId);
  const db = getDb();
  refreshStashConfig(db, snapshot);
  const row = db
    .prepare('SELECT * FROM compiled_configs WHERE profile_id = ?')
    .get(profileId) as
    | { revision: number; artifact_ciphertext: string; created_at: string }
    | undefined;
  if (row) {
    const artifact = decryptJson<ExportResult>(row.artifact_ciphertext);
    try { assertArtifactSemantics(artifact); }
    catch (error) {
      if (error instanceof HttpError && error.status === 409) return { snapshot, row: undefined };
      throw error;
    }
    return { snapshot, row, artifact };
  }
  return { snapshot, row: undefined };
}
export function getDeliveryStatus(profileId: number) {
  const { snapshot, row, artifact } = artifactRow(profileId);
  const token = readDownloadToken(profileId);
  const issues = stashTargetIssues(snapshot);
  return {
    currentRevision: snapshot.profile.revision,
    compiledRevision: row?.revision ?? null,
    current: row?.revision === snapshot.profile.revision,
    ...(issues.length ? { issues } : {}),
    generatedAt: row?.created_at ?? null,
    ...(artifact?.proxyRewrites ? { managedProxySources: true } : {}),
    subscriptionPath: token ? `/api/config_download/${token}/config.yaml` : null
  };
}
export function readDownloadToken(profileId: number) {
  const link = getDb()
    .prepare('SELECT token_ciphertext FROM download_links WHERE profile_id = ?')
    .get(profileId) as { token_ciphertext: string } | undefined;
  return link ? decryptJson<string>(link.token_ciphertext) : null;
}
export function ensureDownloadToken(profileId: number) {
  const current = readDownloadToken(profileId);
  if (current) return current;
  const token = randomBytes(32).toString('base64url');
  getDb().prepare(`INSERT INTO download_links (profile_id, token_hash, token_ciphertext, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(profile_id) DO NOTHING`)
    .run(profileId, createHash('sha256').update(token).digest('hex'), encryptJson(token), new Date().toISOString());
  return readDownloadToken(profileId) ?? token;
}
export function getLatestConfig(profileId: number) {
  const { snapshot, row, artifact } = artifactRow(profileId);
  if (!row || !artifact)
    throw new HttpError(
      409,
      '当前配置尚未成功生成。请先修复配置检查中的错误。'
    );
  return {
    ...artifact,
    revision: row.revision,
    currentRevision: snapshot.profile.revision,
    generatedAt: row.created_at
  };
}
export function rotateDownloadLink(profileId: number) {
  getCompilationSnapshot(profileId);
  const token = randomBytes(32).toString('base64url');
  getDb()
    .prepare(
      `INSERT INTO download_links (profile_id, token_hash, token_ciphertext, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET token_hash = excluded.token_hash,
    token_ciphertext = excluded.token_ciphertext, created_at = excluded.created_at`
    )
    .run(
      profileId,
      createHash('sha256').update(token).digest('hex'),
      encryptJson(token),
      new Date().toISOString()
    );
  return getDeliveryStatus(profileId);
}
export function revokeDownloadLink(profileId: number) {
  getCompilationSnapshot(profileId);
  getDb()
    .prepare('DELETE FROM download_links WHERE profile_id = ?')
    .run(profileId);
}
export function configForToken(token: string) {
  // Only persisted, successful artifacts are read on a device download. No draft compilation here.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new HttpError(404, 'Download link not found');
  const link = getDb()
    .prepare('SELECT profile_id FROM download_links WHERE token_hash = ?')
    .get(createHash('sha256').update(token).digest('hex')) as
    | { profile_id: number }
    | undefined;
  if (!link) throw new HttpError(404, 'Download link not found');
  return readPersistedStashArtifact(link.profile_id);
}
export function readPersistedStashArtifact(profileId: number) {
  const row = getDb()
    .prepare('SELECT * FROM compiled_configs WHERE profile_id = ?')
    .get(profileId) as
    | { revision: number; artifact_ciphertext: string }
    | undefined;
  if (!row)
    throw new HttpError(
      409,
      'No successfully compiled configuration is available'
    );
  const artifact = decryptJson<ExportResult>(row.artifact_ciphertext);
  assertArtifactSemantics(artifact);
  return {
    ...artifact,
    revision: row.revision
  };
}
