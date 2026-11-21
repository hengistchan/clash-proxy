import { configSubscriptionPath, type ConfigDeliveryStatus } from './config-targets';
import { decryptJson } from './crypto';
import { getDb } from './db';
import { profileForTargetToken, readTargetToken, revokeTargetToken, rotateTargetToken } from './download-link-store';
import type { ExportResult } from './exporter';
import { HttpError } from './http';
import { managedSourceHealth } from './managed-source-health';
import { mihomoCompiledRevision, mihomoIssues, refreshMihomoConfig } from './mihomo-compilation';
import { getCompilationSnapshot } from './repository';
import { managedSources, publicationStatus, servedRecord } from './target-publication-store';
import type { Snapshot } from './types';

function prepareMihomo(profileId: number, snapshot = getCompilationSnapshot(profileId)) {
  refreshMihomoConfig(getDb(), snapshot);
  return snapshot.profile.revision;
}

export function getMihomoStatus(profileId: number, sharedSnapshot?: Snapshot): ConfigDeliveryStatus {
  const currentRevision = prepareMihomo(profileId, sharedSnapshot);
  const db = getDb();
  const served = servedRecord(db, profileId, 'mihomo');
  const sources = managedSources(served);
  const issues = mihomoIssues(db, profileId);
  const release = publicationStatus(db, profileId, 'mihomo');
  return {
    currentRevision,
    compiledRevision: served?.revision ?? null,
    current: served?.revision === currentRevision &&
      (release.deliveryMode === 'manual' || !issues.some(issue => issue.severity === 'error')),
    readyRevision: mihomoCompiledRevision(db, profileId),
    generatedAt: served?.created_at ?? null,
    subscriptionPath: configSubscriptionPath('mihomo', readTargetToken(db, 'mihomo', profileId)),
    ...release,
    issues,
    managedSources: managedSourceHealth(db, profileId, sources, 'mihomo'),
    managedProxySources: sources.length > 0
  };
}

export function readPersistedMihomoArtifact(profileId: number) {
  const db = getDb();
  const row = servedRecord(db, profileId, 'mihomo');
  if (!row) throw new HttpError(409, '尚无可用的 Mihomo 配置。请查看下载页的兼容性检查。', mihomoIssues(db, profileId));
  return { ...decryptJson<ExportResult>(row.artifact_ciphertext), revision: row.revision };
}

export function getLatestMihomoConfig(profileId: number) {
  prepareMihomo(profileId);
  return readPersistedMihomoArtifact(profileId);
}

export function mihomoConfigForToken(token: string) {
  return readPersistedMihomoArtifact(profileForTargetToken(getDb(), 'mihomo', token));
}

export function rotateMihomoLink(profileId: number) {
  prepareMihomo(profileId);
  const db = getDb();
  return db.transaction(() => {
    readPersistedMihomoArtifact(profileId);
    rotateTargetToken(db, 'mihomo', profileId);
    return getMihomoStatus(profileId);
  }).immediate();
}

export function revokeMihomoLink(profileId: number) {
  getCompilationSnapshot(profileId);
  revokeTargetToken(getDb(), 'mihomo', profileId);
}
