import { createHash, randomBytes } from 'node:crypto';
import { decryptJson, encryptJson } from './crypto';
import { getDb } from './db';
import { HttpError } from './http';
import { getCompilationSnapshot } from './repository';
import { compileShadowrocket, SHADOWROCKET_COMPILER_VERSION, type ShadowrocketArtifact } from './shadowrocket';
import { refreshShadowrocketConfig, storeShadowrocketRefresh } from './shadowrocket-compilation';
import { readRemoteSources } from './shadowrocket-sources';
import type { ValidationIssue } from './types';
import type { SourceDownload } from './upstream-download';

const REFRESH_MS = 60_000;
const MAX_REFRESHING_PROFILES = 4;
const refreshing = new Map<number, Promise<void>>();

type ArtifactRow = {
  revision: number | null;
  artifact_version: number | null;
  artifact_ciphertext: string | null;
  created_at: string | null;
  issues_json: string;
  checked_revision: number;
  remote_sources: number;
  remote_checked_at: number | null;
};

function getRow(profileId: number) {
  return getDb().prepare('SELECT * FROM shadowrocket_compilations WHERE profile_id = ?')
    .get(profileId) as ArtifactRow | undefined;
}

function refresh(profileId: number) {
  const snapshot = getCompilationSnapshot(profileId);
  refreshShadowrocketConfig(getDb(), snapshot);
  return { snapshot, row: getRow(profileId) };
}

function isDeliverable(row: ArtifactRow | undefined): row is ArtifactRow & { revision: number; artifact_ciphertext: string } {
  // These revisions extend mappings without invalidating earlier complete output.
  return row?.artifact_version != null && row.artifact_version >= 1 && row.artifact_version <= SHADOWROCKET_COMPILER_VERSION &&
    row.revision !== null && row.artifact_ciphertext !== null;
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

async function refreshUpstream(profileId: number, fetchSource?: SourceDownload) {
  const { snapshot, row } = refresh(profileId);
  if (!row?.remote_sources || row.checked_revision !== snapshot.profile.revision ||
    (row.remote_checked_at !== null && Date.now() - row.remote_checked_at < REFRESH_MS)) return;
  const pending = refreshing.get(profileId);
  if (pending) return pending;
  if (refreshing.size >= MAX_REFRESHING_PROFILES) {
    if (isDeliverable(row)) return;
    throw new HttpError(503, '远程来源正在更新，请稍后重试。');
  }
  const work = (async () => {
    const { sources, issues } = compileShadowrocket(snapshot);
    if (!sources.length) return;
    const fetched = await readRemoteSources(sources, fetchSource);
    const result = fetched.issues.length
      ? { artifact: null, issues: [...issues, ...fetched.issues] }
      : compileShadowrocket(snapshot, fetched.resources);
    storeShadowrocketRefresh(getDb(), snapshot.profile, result.artifact, result.issues);
  })();
  refreshing.set(profileId, work);
  try {
    await work;
  } finally {
    refreshing.delete(profileId);
  }
}

function artifactFrom(row: ArtifactRow | undefined) {
  if (!isDeliverable(row)) return null;
  return { ...decryptJson<ShadowrocketArtifact>(row.artifact_ciphertext), revision: row.revision };
}

export function getShadowrocketStatus(profileId: number) {
  const { row, snapshot } = refresh(profileId);
  const link = getDb().prepare('SELECT token_ciphertext FROM shadowrocket_download_links WHERE profile_id = ?')
    .get(profileId) as { token_ciphertext: string } | undefined;
  const token = link ? decryptJson<string>(link.token_ciphertext) : null;
  const compiledRevision = isDeliverable(row) ? row.revision : null;
  const issues = row ? JSON.parse(row.issues_json) as ValidationIssue[] : [];
  const remoteSources = Boolean(row?.remote_sources);
  if (remoteSources && row?.remote_checked_at === null) {
    issues.unshift({ severity: 'info', code: 'shadowrocket.source.pending', message: '下载配置或生成链接时会拉取远程来源，并检查转换结果。' });
  }
  const currentRevision = snapshot.profile.revision;
  return {
    currentRevision,
    compiledRevision,
    current: compiledRevision === currentRevision && row?.artifact_version === SHADOWROCKET_COMPILER_VERSION &&
      !issues.some((issue) => issue.severity === 'error'),
    generatedAt: compiledRevision === null ? null : row?.created_at ?? null,
    issues,
    remoteSources,
    subscriptionPath: token ? `/api/config_download/${token}/config.conf` : null
  };
}

export async function getLatestShadowrocketConfig(profileId: number, fetchSource?: SourceDownload) {
  await refreshUpstream(profileId, fetchSource);
  const artifact = artifactFrom(getRow(profileId));
  if (!artifact) throw new HttpError(409, '尚无可用的 Shadowrocket 配置。请查看下载页的兼容性检查。');
  return artifact;
}

export async function rotateShadowrocketLink(profileId: number, fetchSource?: SourceDownload) {
  await getLatestShadowrocketConfig(profileId, fetchSource);
  const token = randomBytes(32).toString('base64url');
  getDb().prepare(`INSERT INTO shadowrocket_download_links (profile_id, token_hash, token_ciphertext, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET
      token_hash = excluded.token_hash, token_ciphertext = excluded.token_ciphertext, created_at = excluded.created_at`)
    .run(profileId, tokenHash(token), encryptJson(token), new Date().toISOString());
  return getShadowrocketStatus(profileId);
}

export function revokeShadowrocketLink(profileId: number) {
  getCompilationSnapshot(profileId);
  getDb().prepare('DELETE FROM shadowrocket_download_links WHERE profile_id = ?').run(profileId);
}

function linkForToken(token: string) {
  const link = /^[A-Za-z0-9_-]{43}$/.test(token)
    ? getDb().prepare('SELECT profile_id FROM shadowrocket_download_links WHERE token_hash = ?')
      .get(tokenHash(token)) as { profile_id: number } | undefined
    : undefined;
  if (!link) throw new HttpError(404, 'Download link not found');
  return link.profile_id;
}

export async function shadowrocketConfigForToken(token: string, fetchSource?: SourceDownload) {
  const profileId = linkForToken(token);
  try {
    await refreshUpstream(profileId, fetchSource);
  } catch (error) {
    linkForToken(token); // A deletion or revocation during the fetch still returns 404.
    throw error;
  }
  linkForToken(token);
  const artifact = artifactFrom(getRow(profileId));
  if (!artifact) throw new HttpError(409, 'No successfully compiled Shadowrocket configuration is available');
  return artifact;
}
