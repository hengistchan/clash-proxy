import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getEncryptionKey } from './crypto';
import { HttpError } from './http';
import { readTargetToken } from './download-link-store';

const sourceTables = {
  stash: { access: 'managed_proxy_source_access', cache: 'managed_proxy_source_cache' },
  mihomo: { access: 'mihomo_proxy_source_access', cache: 'mihomo_proxy_source_cache' }
} as const;
export type ManagedSourceTarget = keyof typeof sourceTables;

export function isManagedSourceTarget(value: string): value is ManagedSourceTarget {
  return value === 'stash' || value === 'mihomo';
}

export function managedSourceTables(target: ManagedSourceTarget) {
  return sourceTables[target];
}

function sourceAccess(db: Database.Database, target: ManagedSourceTarget, profileId: number, providerId: number) {
  const { access } = managedSourceTables(target);
  return db.prepare(`SELECT generation, enabled FROM ${access} WHERE profile_id = ? AND provider_id = ?`)
    .get(profileId, providerId) as { generation: string; enabled: number } | undefined;
}

function signature(key: string | Buffer, purpose: string, profileId: number, providerId: number) {
  return createHmac('sha256', key).update(`${purpose}:${profileId}:${providerId}`).digest();
}

export function sourceCapability(db: Database.Database, profileId: number, providerId: number, target: ManagedSourceTarget = 'stash') {
  const epoch = sourceAccess(db, target, profileId, providerId)?.generation ?? 'initial';
  const prefix = target === 'stash' ? 'm1' : 'm2';
  const mac = signature(getEncryptionKey(), sourcePurpose(target, epoch), profileId, providerId);
  return `${prefix}.${profileId}.${providerId}.${mac.toString('hex')}`;
}

function sourcePurpose(target: ManagedSourceTarget, epoch: string) {
  return target === 'stash' ? `managed-source:v1:${epoch}` : `managed-source:v2:${target}:${epoch}`;
}

export function verifySourceCapability(db: Database.Database, capability: string) {
  const match = /^(m[12]\.)?([1-9]\d{0,15})\.([1-9]\d{0,15})\.([a-f0-9]{64})$/.exec(capability);
  const missing = () => new HttpError(404, 'Proxy source link not found');
  if (!match) throw missing();
  const [, independent, profile, provider, hex] = match;
  const profileId = Number(profile), providerId = Number(provider);
  if (!Number.isSafeInteger(profileId) || !Number.isSafeInteger(providerId)) throw missing();
  const target = independent === 'm2.' ? 'mihomo' : 'stash';
  const access = sourceAccess(db, target, profileId, providerId);
  if (access?.enabled === 0) throw missing();
  let expected: Buffer;
  if (independent) {
    expected = signature(getEncryptionKey(), sourcePurpose(target, access?.generation ?? 'initial'), profileId, providerId);
  } else {
    // Preserve previously issued addresses until their original token or source is revoked.
    if (access) throw missing();
    const token = readTargetToken(db, 'stash', profileId);
    if (!token) throw missing();
    expected = signature(token, 'stash-proxy-source', profileId, providerId);
  }
  if (!timingSafeEqual(expected, Buffer.from(hex, 'hex'))) throw missing();
  return { profileId, providerId, target } as const;
}

export function setSourceAccess(
  db: Database.Database, profileId: number, providerId: number, enabled: boolean, target: ManagedSourceTarget = 'stash'
) {
  const { access } = managedSourceTables(target);
  db.prepare(`INSERT INTO ${access} (profile_id, provider_id, generation, enabled)
    VALUES (?, ?, ?, ?) ON CONFLICT (profile_id, provider_id)
    DO UPDATE SET generation = excluded.generation, enabled = excluded.enabled`)
    .run(profileId, providerId, randomBytes(24).toString('hex'), Number(enabled));
}

export function rotateSourceCapability(db: Database.Database, profileId: number, providerId: number) {
  setSourceAccess(db, profileId, providerId, true);
}

export function invalidateSourceCapability(db: Database.Database, profileId: number, providerId: number, target: ManagedSourceTarget = 'stash') {
  setSourceAccess(db, profileId, providerId, sourceAccess(db, target, profileId, providerId)?.enabled !== 0, target);
}

export function managedSourceReference(value: unknown) {
  if (typeof value !== 'string') return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.hostname === 'managed-source.invalid') return { capability: '' };
  const match = /^\/api\/proxy-source\/([^/]+)\/proxies\.yaml\/?$/.exec(url.pathname);
  return match ? { capability: url.search || url.hash ? '' : match[1] } : null;
}
