import { createHmac } from 'node:crypto';
import { decryptJson, encryptJson, getEncryptionKey } from './crypto';
import { getDb } from './db';
import { HttpError } from './http';
import { readRemoteRules } from './shadowrocket-sources';
import { downloadSource, type SourceDownload } from './upstream-download';
import type { RuleProvider, Snapshot } from './types';

const MAX_AGE_MS = 15 * 60_000;
let active = 0;
const fingerprint = (provider: RuleProvider) => createHmac('sha256', getEncryptionKey()).update('rule-analysis:').update(JSON.stringify([provider.behavior, provider.config])).digest('hex');

export function checkedRoutingSnapshot(snapshot: Snapshot) {
  const db = getDb();
  const sourceSnapshots: Array<{ providerId: number; checkedAt: number | null; usable: boolean }> = [];
  const ruleProviders = snapshot.ruleProviders.map(provider => {
    if (provider.providerType !== 'remote') return provider;
    const row = db.prepare('SELECT fingerprint, checked_at, entries_ciphertext FROM rule_source_checks WHERE profile_id = ? AND provider_id = ?')
      .get(snapshot.profile.id, provider.id) as { fingerprint: string; checked_at: number; entries_ciphertext: string } | undefined;
    const usable = Boolean(row && row.fingerprint === fingerprint(provider) && Date.now() - row.checked_at < MAX_AGE_MS);
    sourceSnapshots.push({ providerId: provider.id, checkedAt: row?.checked_at ?? null, usable });
    if (!usable || !row) return provider;
    return { ...provider, providerType: 'inline' as const, entries: decryptJson<string[]>(row.entries_ciphertext).map((value, index) => ({ id: index + 1, sortOrder: index + 1, value })) };
  });
  return { snapshot: { ...snapshot, ruleProviders }, sourceSnapshots };
}

export async function checkRoutingSources(snapshot: Snapshot, fetchSource: SourceDownload = downloadSource) {
  const used = new Set(snapshot.rules.filter(rule => rule.enabled && rule.type === 'RULE-SET').map(rule => rule.payload));
  const sources = snapshot.ruleProviders.filter(provider => used.has(provider.name) && provider.providerType === 'remote' && provider.config.format !== 'mrs');
  if (sources.length > 24) throw new HttpError(409, '最多同时检查 24 个远程规则集。');
  if (active >= 4) throw new HttpError(503, '规则来源检查繁忙，请稍后重试。');
  active++;
  try {
    const results: Array<{ providerId: number; state: 'ready' | 'failed' }> = [];
    const signal = AbortSignal.timeout(12_000);
    for (let start = 0; start < sources.length; start += 4) {
      results.push(...await Promise.all(sources.slice(start, start + 4).map(async provider => {
        const spec = fingerprint(provider);
        try {
          const entries = readRemoteRules(await fetchSource(provider.config, signal), provider.config.format === 'text' ? 'text' : 'yaml');
          const db = getDb();
          const current = db.prepare('SELECT revision FROM profiles WHERE id = ?').pluck().get(snapshot.profile.id);
          if (current !== snapshot.profile.revision) throw new HttpError(409, '规则在检查期间发生变化，请重试。');
          db.prepare(`INSERT INTO rule_source_checks (profile_id, provider_id, fingerprint, checked_at, entries_ciphertext)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(profile_id, provider_id) DO UPDATE SET
            fingerprint = excluded.fingerprint, checked_at = excluded.checked_at, entries_ciphertext = excluded.entries_ciphertext`)
            .run(snapshot.profile.id, provider.id, spec, Date.now(), encryptJson(entries));
          return { providerId: provider.id, state: 'ready' as const };
        } catch (error) {
          if (error instanceof HttpError && error.status === 409) throw error;
          // A failed explicit refresh must not certify an earlier snapshot as fresh.
          getDb().prepare('DELETE FROM rule_source_checks WHERE profile_id = ? AND provider_id = ? AND fingerprint = ?').run(snapshot.profile.id, provider.id, spec);
          return { providerId: provider.id, state: 'failed' as const };
        }
      })));
    }
    return { results, sourceSnapshots: checkedRoutingSnapshot(snapshot).sourceSnapshots };
  } finally { active--; }
}
