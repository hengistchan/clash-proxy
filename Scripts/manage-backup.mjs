import Database from 'better-sqlite3';
import { createHash, createDecipheriv } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function hashFile(file) {
  const fd = openSync(file, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  try { let size; while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size)); }
  finally { closeSync(fd); }
  return digest.digest('hex');
}
const basename = ['stash', 'config'].join('-') + '.sqlite3';
const names = { database: basename, key: basename + '.key', manifest: 'manifest.json' };
function configuredKey() {
  const raw = process.env.STASH_SECRET_KEY?.trim();
  if (raw) return /^[a-f\d]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  const database = path.resolve(root, process.env.STASH_DB_PATH || path.join('data', basename));
  return readFileSync(path.resolve(root, process.env.STASH_KEY_PATH || `${database}.key`));
}

function decrypt(ciphertext, key) {
  const text = String(ciphertext).replace(/^model1:/, '');
  const [version, nonce, tag, body] = text.split('.');
  if (!['v1', 'v2'].includes(version) || !nonce || !tag || !body) throw new Error('ciphertext');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]);
  JSON.parse((version === 'v2' ? inflateRawSync(plain, { maxOutputLength: 64 * 1024 * 1024 }) : plain).toString('utf8'));
}

export function verifyBackup(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, names.manifest), 'utf8'));
  const key = readFileSync(path.join(directory, names.key));
  if (manifest.format !== 1 || key.length !== 32 || manifest.databaseSha256 !== hashFile(path.join(directory, names.database)) || manifest.keySha256 !== hash(key)) throw new Error('manifest');
  const db = new Database(path.join(directory, names.database), { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length || db.pragma('user_version', { simple: true }) !== manifest.schemaVersion) throw new Error('integrity');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    let encryptedValues = 0;
    for (const { name } of tables) {
      const identifier = value => '"' + value.replaceAll('"', '""') + '"';
      for (const column of db.pragma(`table_info(${identifier(name)})`).filter(column => column.name.endsWith('_ciphertext'))) {
        for (const row of db.prepare(`SELECT ${identifier(column.name)} AS value FROM ${identifier(name)} WHERE ${identifier(column.name)} IS NOT NULL`).iterate()) {
          decrypt(row.value, key); encryptedValues++;
        }
      }
    }
    return { schemaVersion: manifest.schemaVersion, encryptedValues };
  } finally { db.close(); }
}

function newDirectory(destination) {
  if (destination.split(path.sep).includes('.next') || existsSync(destination)) throw new Error('destination');
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
}

export async function createBackup(destination) {
  const database = path.resolve(root, process.env.STASH_DB_PATH || path.join('data', basename));
  const key = configuredKey();
  if (key.length !== 32) throw new Error('key');
  const staging = `${destination}.partial-${process.pid}`;
  if (existsSync(destination)) throw new Error('destination');
  newDirectory(staging);
  try {
    const db = new Database(database, { readonly: true, fileMustExist: true });
    try { await db.backup(path.join(staging, names.database)); }
    finally { db.close(); }
    writeFileSync(path.join(staging, names.key), key, { mode: 0o600, flag: 'wx' });
    chmodSync(path.join(staging, names.database), 0o600);
    const copied = new Database(path.join(staging, names.database), { readonly: true });
    const schemaVersion = copied.pragma('user_version', { simple: true });
    copied.close();
    writeFileSync(path.join(staging, names.manifest), JSON.stringify({ format: 1, createdAt: new Date().toISOString(), schemaVersion,
      databaseSha256: hashFile(path.join(staging, names.database)), keySha256: hash(key) }, null, 2), { mode: 0o600, flag: 'wx' });
    const result = verifyBackup(staging);
    // Reserve the destination exclusively before moving files into it.
    newDirectory(destination);
    try { for (const name of Object.values(names)) renameSync(path.join(staging, name), path.join(destination, name)); }
    catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
    return result;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function restoreBackup(source, destination) {
  const result = verifyBackup(source);
  newDirectory(destination);
  try {
    for (const name of Object.values(names)) { copyFileSync(path.join(source, name), path.join(destination, name)); chmodSync(path.join(destination, name), 0o600); }
    verifyBackup(destination);
    return result;
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, source, destination] = process.argv.slice(2);
  process.umask(0o077);
  try {
    if (!source || !['create', 'verify', 'restore'].includes(command) || (command === 'restore' && !destination)) throw new Error('arguments');
    const result = command === 'create' ? await createBackup(path.resolve(source))
      : command === 'verify' ? verifyBackup(path.resolve(source)) : restoreBackup(path.resolve(source), path.resolve(destination));
    console.log(JSON.stringify({ status: 'ok', operation: command, ...result }));
  } catch {
    console.error('备份操作失败。请检查参数、数据库与密钥是否匹配、备份是否完整，以及目标目录是否尚不存在。不会覆盖现有目标。');
    process.exitCode = 1;
  }
}
