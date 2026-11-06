import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import type { JsonValue } from './types';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const CIPHER = 'aes-256-gcm';
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

let cachedKey: Buffer | null = null;

export function databasePath(): string {
  const configured = process.env.STASH_DB_PATH;
  return configured
    ? path.resolve(/*turbopackIgnore: true*/ configured)
    : path.join(process.cwd(), 'data', 'stash-config.sqlite3');
}

function keyPath(): string {
  const configured = process.env.STASH_KEY_PATH;
  return configured
    ? path.resolve(/*turbopackIgnore: true*/ configured)
    : `${databasePath()}.key`;
}

function parseConfiguredKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const decoded = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (decoded.length !== KEY_BYTES) {
    throw new Error('STASH_SECRET_KEY must encode exactly 32 bytes');
  }
  return decoded;
}

export function getEncryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  const configured = process.env.STASH_SECRET_KEY?.trim();
  if (configured) {
    cachedKey = parseConfiguredKey(configured);
    return cachedKey;
  }

  const file = keyPath();
  if (existsSync(/*turbopackIgnore: true*/ file)) {
    const key = readFileSync(/*turbopackIgnore: true*/ file);
    if (key.length !== KEY_BYTES) {
      throw new Error(`Invalid encryption key file: ${file}`);
    }
    cachedKey = key;
    return key;
  }

  mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(/*turbopackIgnore: true*/ file, key, { mode: 0o600, flag: 'wx' });
  chmodSync(/*turbopackIgnore: true*/ file, 0o600);
  cachedKey = key;
  return key;
}

export function encryptJson(value: JsonValue): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, getEncryptionKey(), nonce);
  const plaintext = deflateRawSync(Buffer.from(JSON.stringify(value), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v2',
    nonce.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url')
  ].join('.');
}

export function decryptJson<T = JsonValue>(token: string): T {
  const [version, nonceText, tagText, ciphertextText] = token.split('.');
  if ((version !== 'v1' && version !== 'v2') || !nonceText || !tagText || !ciphertextText) {
    throw new Error('Unsupported encrypted value');
  }
  const decipher = createDecipheriv(
    CIPHER,
    getEncryptionKey(),
    Buffer.from(nonceText, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final()
  ]);
  const plaintext = version === 'v2'
    ? inflateRawSync(decrypted, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
    : decrypted;
  return JSON.parse(plaintext.toString('utf8')) as T;
}

export function resetEncryptionCacheForTests(): void {
  cachedKey = null;
}
