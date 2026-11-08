import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { decryptJson, getEncryptionKey } from './crypto';
import { HttpError } from './http';

function sourceAccess(db: Database.Database, profileId: number, providerId: number) {
  return (db.prepare('SELECT generation, enabled FROM managed_proxy_source_access WHERE profile_id = ? AND provider_id = ?')
    .get(profileId, providerId) as { generation: string; enabled: number } | undefined);
}

function signature(key: string | Buffer, purpose: string, profileId: number, providerId: number) {
  return createHmac('sha256', key).update(`${purpose}:${profileId}:${providerId}`).digest();
}

export function sourceCapability(db: Database.Database, profileId: number, providerId: number) {
  const epoch = sourceAccess(db, profileId, providerId)?.generation ?? 'initial';
  const mac = signature(getEncryptionKey(), `managed-source:v1:${epoch}`, profileId, providerId);
  return `m1.${profileId}.${providerId}.${mac.toString('hex')}`;
}

export function verifySourceCapability(db: Database.Database, capability: string) {
  const match = /^(m1\.)?([1-9]\d{0,15})\.([1-9]\d{0,15})\.([a-f0-9]{64})$/.exec(capability);
  const missing = () => new HttpError(404, 'Proxy source link not found');
  if (!match) throw missing();
  const [, independent, profile, provider, hex] = match;
  const profileId = Number(profile), providerId = Number(provider);
  if (!Number.isSafeInteger(profileId) || !Number.isSafeInteger(providerId)) throw missing();
  const access = sourceAccess(db, profileId, providerId);
  if (access?.enabled === 0) throw missing();
  let expected: Buffer;
  if (independent) {
    expected = signature(getEncryptionKey(), `managed-source:v1:${access?.generation ?? 'initial'}`, profileId, providerId);
  } else {
    // Preserve previously issued addresses until their original token or source is revoked.
    if (access) throw missing();
    const row = db.prepare('SELECT token_ciphertext FROM download_links WHERE profile_id = ?')
      .get(profileId) as { token_ciphertext: string } | undefined;
    if (!row) throw missing();
    expected = signature(decryptJson<string>(row.token_ciphertext), 'stash-proxy-source', profileId, providerId);
  }
  if (!timingSafeEqual(expected, Buffer.from(hex, 'hex'))) throw missing();
  return { profileId, providerId };
}

export function setSourceAccess(
  db: Database.Database, profileId: number, providerId: number, enabled: boolean
) {
  db.prepare(`INSERT INTO managed_proxy_source_access (profile_id, provider_id, generation, enabled)
    VALUES (?, ?, ?, ?) ON CONFLICT (profile_id, provider_id)
    DO UPDATE SET generation = excluded.generation, enabled = excluded.enabled`)
    .run(profileId, providerId, randomBytes(24).toString('hex'), Number(enabled));
}

export function rotateSourceCapability(db: Database.Database, profileId: number, providerId: number) {
  setSourceAccess(db, profileId, providerId, true);
}

export function invalidateSourceCapability(db: Database.Database, profileId: number, providerId: number) {
  setSourceAccess(db, profileId, providerId, sourceAccess(db, profileId, providerId)?.enabled !== 0);
}

export function managedSourceReference(value: unknown) {
  if (typeof value !== 'string') return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.hostname === 'managed-source.invalid') return { capability: '' };
  const match = /^\/api\/proxy-source\/([^/]+)\/proxies\.yaml\/?$/.exec(url.pathname);
  return match ? { capability: url.search || url.hash ? '' : match[1] } : null;
}
