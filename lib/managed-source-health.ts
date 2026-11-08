import { createHmac } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getEncryptionKey } from './crypto';
import type { ManagedProxySource } from './exporter';
import { invalidateSourceCapability } from './managed-source-access';

const hash = (value: unknown) => createHmac('sha256', getEncryptionKey())
  .update('managed-proxy-source-cache:').update(JSON.stringify(value)).digest('hex');

export function sourceFingerprints(source: ManagedProxySource) {
  const sourceKey = hash(source.upstream);
  return { sourceKey, specKey: hash([sourceKey, source.rules]) };
}

export function managedSourceHealth(db: Database.Database, profileId: number, sources: ManagedProxySource[]) {
  const rows = db.prepare(`SELECT provider_id, attempt_fingerprint, attempted_at, source_fingerprint,
    successful_fingerprint, successful_at FROM managed_proxy_source_cache WHERE profile_id = ?`).all(profileId) as Array<{
      provider_id: number; source_fingerprint: string; attempt_fingerprint: string;
      attempted_at: number; successful_fingerprint: string | null; successful_at: number | null;
    }>;
  const byId = new Map(rows.map((row) => [row.provider_id, row]));
  const revoked = new Set((db.prepare('SELECT provider_id FROM managed_proxy_source_access WHERE profile_id = ? AND enabled = 0')
    .all(profileId) as Array<{ provider_id: number }>).map(row => row.provider_id));
  return sources.map((source) => {
    const { sourceKey, specKey } = sourceFingerprints(source);
    const row = byId.get(source.id);
    const lastSuccess = row?.source_fingerprint === sourceKey ? row.successful_at : null;
    const lastAttempt = row?.attempt_fingerprint === specKey ? row.attempted_at : null;
    const state = revoked.has(source.id) ? 'revoked' : lastAttempt == null ? (lastSuccess == null ? 'pending' : 'stale')
      : row?.successful_fingerprint === specKey && lastSuccess === lastAttempt ? 'ready'
      : lastSuccess == null ? 'failed' : 'stale';
    return { id: source.id, name: source.name, state, lastAttempt: lastAttempt ?? null, lastSuccess: lastSuccess ?? null } as const;
  });
}

export function reconcileServedSources(
  db: Database.Database, profileId: number, before: ManagedProxySource[], after: ManagedProxySource[]
) {
  const retained = new Set(after.map(({ id }) => id));
  for (const { id } of before) {
    if (retained.has(id)) continue;
    invalidateSourceCapability(db, profileId, id);
    db.prepare('DELETE FROM managed_proxy_source_cache WHERE profile_id = ? AND provider_id = ?').run(profileId, id);
  }
}
