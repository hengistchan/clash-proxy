import type Database from 'better-sqlite3';
import { candidateFingerprint, managedSources, mihomoCandidate, stashCandidate, type ArtifactRecord } from './target-publication-store';
import type { ManagedSourceTarget } from './managed-source-access';
import { transformProxySource } from './proxy-source-transform';
import { downloadSource, type SourceDownload } from './upstream-download';
import { HttpError } from './http';

const MAX_AGE_MS = 10 * 60_000;
type SourceResult = { id: number; name: string; state: 'ready' | 'failed' };
type CheckRow = { fingerprint: string; checked_at: number; sources_json: string };
const active = new Map<string, Promise<void>>();
const readCandidate = (db: Database.Database, id: number, target: ManagedSourceTarget) => target === 'stash' ? stashCandidate(db, id) : mihomoCandidate(db, id);

export function candidateSourceStatus(db: Database.Database, profileId: number, target: ManagedSourceTarget, candidate = readCandidate(db, profileId, target)) {
  const sources = managedSources(candidate);
  if (!sources.length) return { state: 'none' as const, checkedAt: null, sources: [] as SourceResult[] };
  const row = db.prepare('SELECT * FROM candidate_source_checks WHERE profile_id = ? AND target = ?').get(profileId, target) as CheckRow | undefined;
  if (!candidate || !row || row.fingerprint !== candidateFingerprint(candidate)) {
    return { state: 'pending' as const, checkedAt: null, sources: sources.map(({ id, name }) => ({ id, name, state: 'pending' as const })) };
  }
  const results = JSON.parse(row.sources_json) as SourceResult[];
  const expired = Date.now() - row.checked_at >= MAX_AGE_MS;
  return { state: expired ? 'stale' as const : results.some(source => source.state === 'failed') ? 'failed' as const : 'ready' as const, checkedAt: row.checked_at, sources: results };
}

/** Candidate I/O never changes device capabilities or the device's fallback cache. */
export async function checkCandidateSources(db: Database.Database, profileId: number, target: ManagedSourceTarget, candidate: ArtifactRecord, fetchSource: SourceDownload = downloadSource) {
  const fingerprint = candidateFingerprint(candidate);
  const key = `${profileId}:${target}:${fingerprint}`;
  const pending = active.get(key);
  if (pending) return pending;
  if (active.size >= 4) throw new HttpError(503, '候选来源检查繁忙，请稍后重试。');
  const sources = managedSources(candidate);
  if (sources.length > 24) throw new HttpError(409, '候选版最多同时检查 24 个托管来源。');
  const work = (async () => {
    const results: SourceResult[] = [];
    const signal = AbortSignal.timeout(12_000);
    for (let start = 0; start < sources.length; start += 4) {
      results.push(...await Promise.all(sources.slice(start, start + 4).map(async source => {
        let state: SourceResult['state'] = 'ready';
        try { transformProxySource(await fetchSource(source.upstream, signal), source.rules); }
        catch { state = 'failed'; }
        return { id: source.id, name: source.name, state };
      })));
    }
    db.transaction(() => {
      const current = readCandidate(db, profileId, target);
      const revision = db.prepare('SELECT revision FROM profiles WHERE id = ?').pluck().get(profileId);
      if (!current || current.revision !== revision || candidateFingerprint(current) !== fingerprint) throw new HttpError(409, '候选版在检查期间发生变化，请重试。');
      db.prepare(`INSERT INTO candidate_source_checks (profile_id, target, fingerprint, checked_at, sources_json)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(profile_id, target) DO UPDATE SET
        fingerprint = excluded.fingerprint, checked_at = excluded.checked_at, sources_json = excluded.sources_json`)
        .run(profileId, target, fingerprint, Date.now(), JSON.stringify(results));
    }).immediate();
  })().finally(() => active.delete(key));
  active.set(key, work);
  return work;
}

export function assertCandidateSources(db: Database.Database, profileId: number, target: ManagedSourceTarget, candidate: ArtifactRecord) {
  const status = candidateSourceStatus(db, profileId, target, candidate);
  if (status.state !== 'none' && status.state !== 'ready') throw new HttpError(409, '请先检查待发布版的托管来源；检查失败、过期或版本变化后需要重新检查。');
}
