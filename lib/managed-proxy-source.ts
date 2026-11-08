import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { decryptJson, encryptJson } from './crypto';
import { getDb } from './db';
import { managedSources, servedStashRecord } from './target-publication-store';
import { sourceFingerprints } from './managed-source-health';
import { absoluteDownloadUrl } from './download-response';
import type { ExportResult } from './exporter';
import { sourceCapability, verifySourceCapability } from './managed-source-access';
import { HttpError } from './http';
import { transformProxySource } from './proxy-source-transform';
import { downloadSource, type SourceDownload } from './upstream-download';

const RETRY_MS = 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
export function materializeStashArtifact<T extends ExportResult>(artifact: T, request: Request): T {
  const rewrites = artifact.proxyRewrites;
  if (!rewrites) return artifact;
  const origin = absoluteDownloadUrl(request, '/');
  const db = getDb();
  const document = parseDocument(artifact.yaml);
  for (const source of rewrites.sources) {
    const capability = sourceCapability(db, rewrites.profileId, source.id);
    document.setIn(['proxy-providers', source.name, 'url'], new URL(`/api/proxy-source/${capability}/proxies.yaml`, origin).href);
  }
  const yaml = document.toString({ lineWidth: 0 });
  const { proxyRewrites: _private, ...result } = artifact;
  return { ...result, yaml, sha256: createHash('sha256').update(yaml).digest('hex') } as T;
}

function resolveSource(capability: string) {
  const { profileId, providerId } = verifySourceCapability(getDb(), capability);
  const source = managedSources(servedStashRecord(getDb(), profileId)).find((item) => item.id === providerId);
  if (!source) throw new HttpError(404, 'Proxy source link not found');
  return { profileId, providerId, source };
}

interface CacheRow {
  source_fingerprint: string;
  attempt_fingerprint: string;
  attempted_at: number;
  successful_fingerprint: string | null;
  successful_at: number | null;
  yaml_ciphertext: string | null;
}

const inFlight = new Map<string, Promise<void>>();

export async function managedProxySource(capability: string, fetchSource: SourceDownload = downloadSource, now = Date.now) {
  const { profileId, providerId, source } = resolveSource(capability);
  const { sourceKey, specKey } = sourceFingerprints(source);
  const db = getDb();
  const read = () => db.prepare('SELECT * FROM managed_proxy_source_cache WHERE profile_id = ? AND provider_id = ?')
    .get(profileId, providerId) as CacheRow | undefined;
  const current = () => {
    const { source: latest } = resolveSource(capability);
    return sourceFingerprints(latest).specKey === specKey;
  };
  const row = read();
  let deferred = false;
  const attemptAt = now();
  if (row?.attempt_fingerprint !== specKey || attemptAt - row.attempted_at >= RETRY_MS) {
    const key = `${profileId}:${providerId}:${specKey}`;
    let pending = inFlight.get(key);
    if (!pending && inFlight.size >= 8) {
      if (row?.source_fingerprint !== sourceKey || !row.yaml_ciphertext)
        throw new HttpError(503, 'Proxy source refresh is busy; try again shortly');
      deferred = true;
    } else if (!pending) {
      pending = (async () => {
        let yaml: string | undefined;
        try {
          const text = await fetchSource(source.upstream, AbortSignal.timeout(12_000));
          const result = transformProxySource(text, source.rules);
          if (Buffer.byteLength(result.yaml) <= MAX_BYTES) yaml = result.yaml;
        } catch {
          // Neither parser errors nor upstream errors are safe to expose.
        }
        db.transaction(() => {
          if (!current()) throw new HttpError(503, 'Proxy source changed during refresh; try again shortly');
          db.prepare(`INSERT INTO managed_proxy_source_cache
            (profile_id, provider_id, source_fingerprint, attempt_fingerprint, attempted_at, successful_fingerprint, successful_at, yaml_ciphertext)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(profile_id, provider_id) DO UPDATE SET
              source_fingerprint = excluded.source_fingerprint,
              attempt_fingerprint = excluded.attempt_fingerprint, attempted_at = excluded.attempted_at,
              successful_fingerprint = CASE WHEN excluded.yaml_ciphertext IS NULL AND source_fingerprint = excluded.source_fingerprint
                THEN successful_fingerprint ELSE excluded.successful_fingerprint END,
              successful_at = CASE WHEN excluded.yaml_ciphertext IS NULL AND source_fingerprint = excluded.source_fingerprint
                THEN successful_at ELSE excluded.successful_at END,
              yaml_ciphertext = CASE WHEN excluded.yaml_ciphertext IS NULL AND source_fingerprint = excluded.source_fingerprint
                THEN yaml_ciphertext ELSE excluded.yaml_ciphertext END
            WHERE excluded.attempted_at >= attempted_at`)
            .run(profileId, providerId, sourceKey, specKey, attemptAt, yaml ? specKey : null, yaml ? attemptAt : null, yaml ? encryptJson(yaml) : null);
        }).immediate();
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    await pending;
  }
  if (!current()) throw new HttpError(503, 'Proxy source changed during refresh; try again shortly');
  const saved = read();
  if (saved?.source_fingerprint !== sourceKey || !saved.yaml_ciphertext)
    throw new HttpError(502, 'No successfully transformed proxy source is available');
  return { yaml: decryptJson<string>(saved.yaml_ciphertext), stale: deferred || saved.successful_fingerprint !== specKey || saved.successful_at !== saved.attempted_at };
}
