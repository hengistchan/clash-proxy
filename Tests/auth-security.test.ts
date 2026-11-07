import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { requireAdmin } from '../lib/auth';
import { HttpError } from '../lib/http';
import { GET as profiles } from '../app/api/profiles/route';
import { GET as health } from '../app/api/health/route';
import { GET as metadata } from '../app/api/meta/route';
import { SERVICE_VERSION } from '../lib/version';
import manifest from '../package.json';

const keys = ['NODE_ENV', 'HOSTNAME', 'STASH_ADMIN_TOKEN', 'STASH_ALLOW_INSECURE_LOCAL', 'STASH_DB_PATH', 'STASH_KEY_PATH'];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'forge-auth-boundary-'));
beforeEach(() => {
  for (const key of keys) delete process.env[key];
  process.env.STASH_DB_PATH = path.join(temporary, 'unused.sqlite3');
  process.env.STASH_KEY_PATH = path.join(temporary, 'unused.key');
});
after(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  rmSync(temporary, { recursive: true, force: true });
});

function denied(request: Request, status: number) {
  assert.throws(() => requireAdmin(request), (error) => error instanceof HttpError && error.status === status);
}

test('missing production authentication fails closed regardless of request host or local override', async () => {
  for (const environment of ['production', 'test', undefined]) {
    if (environment) Object.assign(process.env, { NODE_ENV: environment });
    else Reflect.deleteProperty(process.env, 'NODE_ENV');
    process.env.STASH_ALLOW_INSECURE_LOCAL = '1';
    for (const host of ['127.0.0.1', 'localhost', 'forge.example.test']) {
      const request = new Request(`http://${host}/api/profiles`, {
        headers: { Host: 'localhost', 'X-Forwarded-Host': 'localhost', 'X-Forwarded-For': '127.0.0.1' }
      });
      denied(request, 503);
      assert.equal((await profiles(request)).status, 503);
    }
    assert.equal((await health()).status, 503);
  }
  assert.equal(existsSync(process.env.STASH_DB_PATH!), false);
  assert.equal(existsSync(process.env.STASH_KEY_PATH!), false);
});

test('configured authentication cannot be bypassed by development flags, origins or proxy headers', () => {
  Object.assign(process.env, { NODE_ENV: 'development', STASH_ALLOW_INSECURE_LOCAL: '1', STASH_ADMIN_TOKEN: 'fixture-management-only' });
  for (const headers of [
    { 'X-Forwarded-For': '127.0.0.1' },
    { 'X-Admin-Token': 'wrong-fixture-value' },
    { Authorization: 'Bearer wrong-fixture-value' }
  ] as Array<Record<string, string>>) denied(new Request('http://localhost/api/profiles', { headers }), 401);
  for (const headers of [
    { 'X-Admin-Token': 'fixture-management-only' },
    { Authorization: 'Bearer fixture-management-only' }
  ] as Array<Record<string, string>>) assert.doesNotThrow(() => requireAdmin(new Request('https://forge.example.test/api/profiles', { headers })));
});

test('unauthenticated local development requires explicit opt in and rejects cross-origin browser requests', () => {
  Object.assign(process.env, { NODE_ENV: 'development' });
  denied(new Request('http://localhost/api/profiles'), 503);
  process.env.STASH_ALLOW_INSECURE_LOCAL = '1';
  for (const url of ['http://localhost/api/profiles', 'http://127.0.0.1:3010/api/profiles', 'http://[::1]:3010/api/profiles']) {
    assert.doesNotThrow(() => requireAdmin(new Request(url, { headers: { Origin: new URL(url).origin, 'Sec-Fetch-Site': 'same-origin' } })));
  }
  denied(new Request('http://forge.example.test/api/profiles', { headers: { Host: 'localhost' } }), 403);
  denied(new Request('http://localhost/api/profiles', { headers: { Host: 'forge.example.test' } }), 403);
  for (const headers of [
    { Origin: 'https://attacker.example.test' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' }
  ] as Array<Record<string, string>>) denied(new Request('http://localhost/api/profiles', { method: 'POST', headers }), 403);
});

test('metadata uses the package version and accurately describes the authentication boundary', async () => {
  assert.equal(SERVICE_VERSION, manifest.version);
  let data = await (await metadata()).json();
  assert.equal(data.version, manifest.version);
  assert.equal(data.admin_token_required, true);
  Object.assign(process.env, { NODE_ENV: 'development', STASH_ALLOW_INSECURE_LOCAL: '1' });
  data = await (await metadata()).json();
  assert.equal(data.admin_token_required, false);
  process.env.STASH_ADMIN_TOKEN = 'fixture-management-only';
  assert.equal((await (await metadata()).json()).admin_token_required, true);
});
