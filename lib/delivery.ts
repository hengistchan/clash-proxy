import { configSubscriptionPath } from './config-targets';
import { profileForTargetToken, readTargetToken, revokeTargetToken, rotateTargetToken } from './download-link-store';
import { getDb } from './db';
import { decryptJson } from './crypto';
import { refreshStashConfig } from './stash-compilation';
import { stashTargetIssues, type ExportResult } from './exporter';
import { getCompilationSnapshot } from './repository';
import { HttpError } from './http';
import { publicationStatus, servedStashRecord, stashCandidate } from './target-publication-store';
import { managedSourceHealth } from './managed-source-health';
import { validateSnapshot } from './validation';
import { assertArtifactSemantics } from './artifact-semantics';

function artifactRow(profileId: number) {
  const snapshot = getCompilationSnapshot(profileId);
  const db = getDb();
  refreshStashConfig(db, snapshot);
  const row = servedStashRecord(db, profileId);
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
  const db = getDb();
  const issues = [...validateSnapshot(snapshot).issues, ...stashTargetIssues(snapshot)];
  const readyRevision = stashCandidate(db, profileId)?.revision ?? null;
  const managedSources = artifact?.proxyRewrites
    ? managedSourceHealth(db, profileId, artifact.proxyRewrites.sources) : [];
  const release = publicationStatus(db, profileId, 'stash');
  return {
    currentRevision: snapshot.profile.revision,
    compiledRevision: row?.revision ?? null,
    current: row?.revision === snapshot.profile.revision,
    readyRevision,
    ...release,
    managedSources,
    ...(issues.length ? { issues } : {}),
    generatedAt: row?.created_at ?? null,
    ...(artifact?.proxyRewrites ? { managedProxySources: true } : {}),
    subscriptionPath: configSubscriptionPath('stash', token)
  };
}
export function readDownloadToken(profileId: number) {
  return readTargetToken(getDb(), 'stash', profileId);
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
  rotateTargetToken(getDb(), 'stash', profileId);
  return getDeliveryStatus(profileId);
}
export function revokeDownloadLink(profileId: number) {
  getCompilationSnapshot(profileId);
  revokeTargetToken(getDb(), 'stash', profileId);
}
export function configForToken(token: string) {
  // Only persisted, successful artifacts are read on a device download. No draft compilation here.
  return readPersistedStashArtifact(profileForTargetToken(getDb(), 'stash', token));
}
export function readPersistedStashArtifact(profileId: number) {
  const row = servedStashRecord(getDb(), profileId);
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
