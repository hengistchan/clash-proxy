import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConfigTarget } from './config-targets';
import { decryptJson, encryptJson } from './crypto';
import { HttpError } from './http';

const tables = {
  stash: 'download_links',
  shadowrocket: 'shadowrocket_download_links',
  mihomo: 'mihomo_download_links'
} as const satisfies Record<ConfigTarget, string>;

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function readTargetToken(db: Database.Database, target: ConfigTarget, profileId: number) {
  const row = db.prepare(`SELECT token_ciphertext FROM ${tables[target]} WHERE profile_id = ?`)
    .get(profileId) as { token_ciphertext: string } | undefined;
  return row ? decryptJson<string>(row.token_ciphertext) : null;
}

export function rotateTargetToken(db: Database.Database, target: ConfigTarget, profileId: number) {
  const token = randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO ${tables[target]} (profile_id, token_hash, token_ciphertext, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET token_hash = excluded.token_hash,
    token_ciphertext = excluded.token_ciphertext, created_at = excluded.created_at`)
    .run(profileId, tokenHash(token), encryptJson(token), new Date().toISOString());
}

export function revokeTargetToken(db: Database.Database, target: ConfigTarget, profileId: number) {
  db.prepare(`DELETE FROM ${tables[target]} WHERE profile_id = ?`).run(profileId);
}

export function profileForTargetToken(db: Database.Database, target: ConfigTarget, token: string) {
  const link = /^[A-Za-z0-9_-]{43}$/.test(token)
    ? db.prepare(`SELECT profile_id FROM ${tables[target]} WHERE token_hash = ?`)
      .get(tokenHash(token)) as { profile_id: number } | undefined
    : undefined;
  if (!link) throw new HttpError(404, 'Download link not found');
  return link.profile_id;
}
