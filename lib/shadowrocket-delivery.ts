import { configSubscriptionPath } from './config-targets';
import { profileForTargetToken, readTargetToken, revokeTargetToken, rotateTargetToken } from './download-link-store';
import { decryptJson } from './crypto';
import { getDb } from './db';
import { deliveryMode, publicationRecord, publicationStatus } from './target-publication-store';
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

export async function refreshShadowrocketUpstream(profileId: number, fetchSource?: SourceDownload) {
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

function deliveredArtifact(profileId: number) {
  const db = getDb();
  const mode = deliveryMode(db, profileId, 'shadowrocket');
  if (!mode) return artifactFrom(getRow(profileId));
  const record = publicationRecord(db, profileId, 'shadowrocket', mode.publication_id);
  return record ? { ...decryptJson<ShadowrocketArtifact>(record.artifact_ciphertext), revision: record.revision } : null;
}

export function getShadowrocketStatus(profileId: number) {
  const { row, snapshot } = refresh(profileId);
  const db = getDb();
  const token = readTargetToken(db, 'shadowrocket', profileId);
  const mode = deliveryMode(db, profileId, 'shadowrocket');
  const pinned = mode ? publicationRecord(db, profileId, 'shadowrocket', mode.publication_id) : undefined;
  const readyRevision = isDeliverable(row) ? row.revision : null;
  const compiledRevision = mode ? pinned?.revision ?? null : readyRevision;
  const issues = row ? JSON.parse(row.issues_json) as ValidationIssue[] : [];
  const remoteSources = Boolean(row?.remote_sources);
  if (remoteSources && row?.remote_checked_at === null) {
    issues.unshift({ severity: 'info', code: 'shadowrocket.source.pending', message: '下载配置或生成链接时会拉取远程来源，并检查转换结果。' });
  }
  const currentRevision = snapshot.profile.revision;
  return {
    currentRevision,
    compiledRevision,
    current: compiledRevision === currentRevision && (Boolean(mode) || (row?.artifact_version === SHADOWROCKET_COMPILER_VERSION &&
      !issues.some((issue) => issue.severity === 'error'))),
    readyRevision,
    ...publicationStatus(db, profileId, 'shadowrocket'),
    generatedAt: compiledRevision === null ? null : (mode ? pinned?.created_at : row?.created_at) ?? null,
    remoteState: !remoteSources ? 'none' as const : row?.remote_checked_at === null ? 'pending' as const
      : issues.some((issue) => issue.severity === 'error') ? 'failed' as const : 'ready' as const,
    remoteCheckedAt: row?.remote_checked_at ?? null,
    issues,
    remoteSources,
    subscriptionPath: configSubscriptionPath('shadowrocket', token)
  };
}

export function readPersistedShadowrocketArtifact(profileId: number) {
  const artifact = deliveredArtifact(profileId);
  if (!artifact) throw new HttpError(409, '尚无可用的 Shadowrocket 配置。请查看下载页的兼容性检查。');
  return artifact;
}

export async function getLatestShadowrocketConfig(profileId: number, fetchSource?: SourceDownload) {
  if (!deliveryMode(getDb(), profileId, 'shadowrocket')) await refreshShadowrocketUpstream(profileId, fetchSource);
  return readPersistedShadowrocketArtifact(profileId);
}

export async function rotateShadowrocketLink(profileId: number, fetchSource?: SourceDownload) {
  await getLatestShadowrocketConfig(profileId, fetchSource);
  rotateTargetToken(getDb(), 'shadowrocket', profileId);
  return getShadowrocketStatus(profileId);
}

export function revokeShadowrocketLink(profileId: number) {
  getCompilationSnapshot(profileId);
  revokeTargetToken(getDb(), 'shadowrocket', profileId);
}

function linkForToken(token: string) {
  return profileForTargetToken(getDb(), 'shadowrocket', token);
}

export async function shadowrocketConfigForToken(token: string, fetchSource?: SourceDownload) {
  const profileId = linkForToken(token);
  try {
    if (!deliveryMode(getDb(), profileId, 'shadowrocket')) await refreshShadowrocketUpstream(profileId, fetchSource);
  } catch (error) {
    linkForToken(token); // A deletion or revocation during the fetch still returns 404.
    throw error;
  }
  linkForToken(token);
  const artifact = deliveredArtifact(profileId);
  if (!artifact) throw new HttpError(409, 'No successfully compiled Shadowrocket configuration is available');
  return artifact;
}
