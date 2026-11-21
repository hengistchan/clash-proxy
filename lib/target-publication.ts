import type Database from 'better-sqlite3';
import { assertCandidateSources } from './candidate-source-check';
import type { ConfigTarget } from './config-targets';
import { decryptJson } from './crypto';
import { assertArtifactSemantics } from './artifact-semantics';
import { HttpError } from './http';
import { isManagedSourceTarget } from './managed-source-access';
import { mihomoIssues } from './mihomo-compilation';
import { reconcileServedSources } from './managed-source-health';
import type { ExportResult } from './exporter';
import { SHADOWROCKET_COMPILER_VERSION } from './shadowrocket';
import {
  deliveryMode, managedSources, publicationRecord, servedRecord, mihomoCandidate,
  shadowrocketCandidate, stashCandidate, candidateFingerprint, type ArtifactRecord
} from './target-publication-store';

export type PublicationAction = 'manual' | 'auto' | 'publish' | 'rollback';

export { candidateFingerprint } from './target-publication-store';

function readCandidate(db: Database.Database, profileId: number, target: ConfigTarget): ArtifactRecord | undefined {
  if (target === 'mihomo') return mihomoCandidate(db, profileId);
  if (target === 'shadowrocket') {
    const candidate = shadowrocketCandidate(db, profileId);
    return candidate && candidate.artifact_version >= 1 && candidate.artifact_version <= SHADOWROCKET_COMPILER_VERSION
      ? candidate : undefined;
  }
  const candidate = stashCandidate(db, profileId);
  if (candidate) {
    try {
      assertArtifactSemantics(decryptJson<ExportResult>(candidate.artifact_ciphertext));
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      return undefined;
    }
  }
  return candidate;
}

export function publishableCandidate(db: Database.Database, profileId: number, target: ConfigTarget, revision: number) {
  const candidate = readCandidate(db, profileId, target);
  const remote = target === 'shadowrocket' ? db.prepare(
    'SELECT issues_json, remote_sources, remote_checked_at FROM shadowrocket_compilations WHERE profile_id = ?'
  ).get(profileId) as { issues_json: string; remote_sources: number; remote_checked_at: number | null } | undefined : undefined;
  if (candidate?.revision !== revision ||
    (target === 'mihomo' && mihomoIssues(db, profileId).some(issue => issue.severity === 'error')) ||
    (remote && ((remote.remote_sources && remote.remote_checked_at === null) ||
      (JSON.parse(remote.issues_json) as Array<{ severity: string }>).some(issue => issue.severity === 'error')))) {
    throw new HttpError(409, '当前编辑版尚未通过该客户端的检查，设备版本保持不变。');
  }
  return candidate;
}

export function changeTargetPublication(db: Database.Database, profileId: number, target: ConfigTarget, input: {
  action: PublicationAction; expectedMode: 'auto' | 'manual'; expectedPublicationId: number | null; publicationId?: number;
  expectedCandidateFingerprint?: string;
}) {
  const mode = deliveryMode(db, profileId, target);
  if ((mode ? 'manual' : 'auto') !== input.expectedMode || (mode?.publication_id ?? null) !== input.expectedPublicationId) {
    throw new HttpError(409, '此客户端的发布状态已改变，请刷新后重试。');
  }
  const before = isManagedSourceTarget(target) ? servedRecord(db, profileId, target) : undefined;
  const reconcile = () => {
    if (isManagedSourceTarget(target)) {
      reconcileServedSources(db, profileId, managedSources(before), managedSources(servedRecord(db, profileId, target)), target);
    }
  };
  if (input.action === 'auto') {
    db.prepare('DELETE FROM target_delivery_modes WHERE profile_id = ? AND target = ?').run(profileId, target);
    reconcile();
    return;
  }
  if (input.action !== 'manual' && !mode) throw new HttpError(409, '请先切换到手动发布。');
  if (input.action === 'manual' && mode) return;
  if (input.action === 'rollback') {
    const id = input.publicationId;
    const previous = id === undefined ? undefined : publicationRecord(db, profileId, target, id);
    if (!previous) throw new HttpError(404, '此客户端没有对应的发布记录。');
    if (target === 'stash') assertArtifactSemantics(decryptJson<ExportResult>(previous.artifact_ciphertext));
    db.prepare('UPDATE target_delivery_modes SET publication_id = ? WHERE profile_id = ? AND target = ?').run(id, profileId, target);
    reconcile();
    return;
  }

  const candidate = input.action === 'publish'
    ? publishableCandidate(db, profileId, target, Number(db.prepare('SELECT revision FROM profiles WHERE id = ?').pluck().get(profileId)))
    : readCandidate(db, profileId, target);
  if (input.action === 'publish' && candidate && input.expectedCandidateFingerprint &&
      candidateFingerprint(candidate) !== input.expectedCandidateFingerprint) {
    throw new HttpError(409, '待发布配置已变化，请刷新预览后重试。');
  }
  if (input.action === 'publish' && candidate && isManagedSourceTarget(target)) assertCandidateSources(db, profileId, target, candidate);
  const publicationId = candidate ? Number(db.prepare(`INSERT INTO target_publications
    (profile_id, target, revision, artifact_ciphertext, published_at) VALUES (?, ?, ?, ?, ?)`)
    .run(profileId, target, candidate.revision, candidate.artifact_ciphertext, new Date().toISOString()).lastInsertRowid) : null;
  db.prepare(`INSERT INTO target_delivery_modes (profile_id, target, publication_id) VALUES (?, ?, ?)
    ON CONFLICT (profile_id, target) DO UPDATE SET publication_id = excluded.publication_id`).run(profileId, target, publicationId);
  db.prepare(`DELETE FROM target_publications WHERE profile_id = ? AND target = ? AND id NOT IN
    (SELECT id FROM target_publications WHERE profile_id = ? AND target = ? ORDER BY id DESC LIMIT 20)`)
    .run(profileId, target, profileId, target);
  reconcile();
}
