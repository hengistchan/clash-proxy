import { compareConfigurations } from './config-diff';
import { decryptRevision } from './config-storage-model';
import { decryptJson } from './crypto';
import { getDb } from './db';
import type { ExportResult } from './exporter';
import { HttpError } from './http';
import { mihomoIssues } from './mihomo-compilation';
import type { ShadowrocketArtifact } from './shadowrocket';
import { candidateFingerprint, publishableCandidate } from './target-publication';
import { deliveryMode, servedRecord } from './target-publication-store';
import type { ConfigTarget } from './config-targets';

export function previewPublicationCandidate(profileId: number, target: ConfigTarget, revision: number) {
  const db = getDb();
  if (!deliveryMode(db, profileId, target)) throw new HttpError(409, '请先切换到手动发布。');
  const candidate = publishableCandidate(db, profileId, target, revision);
  const served = servedRecord(db, profileId, target);
  const artifact = decryptJson<ExportResult | ShadowrocketArtifact>(candidate.artifact_ciphertext);
  const readRevision = (number: number) => {
    const row = db.prepare('SELECT config_ciphertext FROM revisions WHERE profile_id = ? AND revision = ?')
      .get(profileId, number) as { config_ciphertext: string } | undefined;
    return row ? decryptRevision(row.config_ciphertext) : null;
  };
  const current = readRevision(candidate.revision);
  const base = served ? readRevision(served.revision) : null;
  const deployed = served ? decryptJson<ExportResult | ShadowrocketArtifact>(served.artifact_ciphertext) : null;
  return {
    revision: candidate.revision,
    fingerprint: candidateFingerprint(candidate),
    servedRevision: served?.revision ?? null,
    content: 'conf' in artifact ? artifact.conf : artifact.yaml,
    outputChanged: deployed ? deployed.sha256 !== artifact.sha256 : null,
    hasManagedSources: 'yaml' in artifact && Boolean(artifact.proxyRewrites?.sources.length),
    changes: base && current ? compareConfigurations(base, current) : null,
    warnings: target === 'mihomo' ? mihomoIssues(db, profileId).filter(issue => issue.severity === 'warning') : []
  };
}

export type CandidatePreview = ReturnType<typeof previewPublicationCandidate>;
