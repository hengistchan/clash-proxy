import { createHash, randomBytes } from 'node:crypto';
import { getDb } from './db';
import { decryptJson, encryptJson } from './crypto';
import { refreshCompiledConfig } from './compilation';
import type { ExportResult } from './exporter';
import { getCompilationSnapshot } from './repository';
import { HttpError } from './http';

function artifactRow(profileId: number) {
  const snapshot = getCompilationSnapshot(profileId);
  const db = getDb();
  refreshCompiledConfig(db, snapshot);
  const row = db
    .prepare('SELECT * FROM compiled_configs WHERE profile_id = ?')
    .get(profileId) as
    | { revision: number; artifact_ciphertext: string; created_at: string }
    | undefined;
  return { snapshot, row };
}
export function getDeliveryStatus(profileId: number) {
  const { snapshot, row } = artifactRow(profileId);
  const link = getDb()
    .prepare('SELECT token_ciphertext FROM download_links WHERE profile_id = ?')
    .get(profileId) as { token_ciphertext: string } | undefined;
  const token = link ? decryptJson<string>(link.token_ciphertext) : null;
  return {
    currentRevision: snapshot.profile.revision,
    compiledRevision: row?.revision ?? null,
    current: row?.revision === snapshot.profile.revision,
    generatedAt: row?.created_at ?? null,
    subscriptionPath: token ? `/api/config_download/${token}/config.yaml` : null
  };
}
export function getLatestConfig(profileId: number) {
  const { snapshot, row } = artifactRow(profileId);
  if (!row)
    throw new HttpError(
      409,
      '当前配置尚未成功生成。请先修复配置检查中的错误。'
    );
  return {
    ...decryptJson<ExportResult>(row.artifact_ciphertext),
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
  const row = getDb()
    .prepare('SELECT * FROM compiled_configs WHERE profile_id = ?')
    .get(link.profile_id) as
    | { revision: number; artifact_ciphertext: string }
    | undefined;
  if (!row)
    throw new HttpError(
      409,
      'No successfully compiled configuration is available'
    );
  return {
    ...decryptJson<ExportResult>(row.artifact_ciphertext),
    revision: row.revision
  };
}
