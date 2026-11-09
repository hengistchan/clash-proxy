import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { parse } from 'yaml';
import { GET as download } from '../app/api/profiles/[profileId]/mihomo/config_download/route';
import { resetEncryptionCacheForTests } from '../lib/crypto';
import { closeDbForTests, getDb } from '../lib/db';
import { getLatestConfig } from '../lib/delivery';
import { setSourceAccess } from '../lib/managed-source-access';
import { createProfile, createProxyProvider, getSnapshot, resetRepositoryForTests } from '../lib/repository';
import { changeTargetPublication } from '../lib/target-publication';

const dir = mkdtempSync(join(tmpdir(), 'forge-mihomo-tests-'));
const admin = ['mihomo', 'fixture', 'admin'].join('-');
let serial = 0;
beforeEach(() => {
  closeDbForTests();
  resetRepositoryForTests();
  resetEncryptionCacheForTests();
  process.env.STASH_DB_PATH = join(dir, `${++serial}.sqlite3`);
  process.env.STASH_KEY_PATH = join(dir, `${serial}.key`);
  process.env.STASH_ADMIN_TOKEN = admin;
  process.env.STASH_PUBLIC_BASE_URL = 'https://forge.example.test';
  delete process.env.STASH_SEED_EXAMPLE;
  delete process.env.STASH_SECRET_KEY;
});
after(() => {
  closeDbForTests();
  rmSync(dir, { recursive: true, force: true });
});

function request(id: number, authenticated = true, query = '') {
  return download(new Request(`https://forge.example.test/api/profiles/${id}/mihomo/config_download${query}`, {
    headers: authenticated ? { 'X-Admin-Token': admin } : {}
  }), { params: Promise.resolve({ profileId: String(id) }) });
}

test('Mihomo export uses the current saved revision even when Stash is pinned to an older file', async () => {
  const { profile } = createProfile('Mihomo', `
dns:
  follow-rule: true
  nameserver: [1.1.1.1]
  proxy-server-nameserver: [8.8.8.8]
http: { mitm: ["*.example.test"] }
proxy-providers:
  remote:
    url: https://proxy.example.test/private-feed
    headers: { X-Test: proxy-fixture }
proxy-groups:
  - {name: Outlet, type: select, proxies: [DIRECT], use: [remote]}
rule-providers:
  domains: {type: inline, behavior: domain, payload: ["+.example.test"]}
  local: {path: ./local.yaml, behavior: classical}
  remote: {url: https://rules.example.test/rules, format: text, behavior: domain, headers: {X-Test: [a, b]}}
rules:
  - AND,((DOMAIN,foo.example.test),(SRC-IP,192.0.2.0/24)),Outlet
  - RULE-SET,domains,REJECT
  - MATCH,DIRECT
`);
  changeTargetPublication(getDb(), profile.id, 'stash', { action: 'manual', expectedMode: 'auto', expectedPublicationId: null });
  const old = getLatestConfig(profile.id);
  const current = createProxyProvider(profile.id, {
    name: 'second', config: { type: 'file', path: './second.yaml' }
  });
  assert.equal((await request(profile.id, false)).status, 401);
  assert.equal((await request(profile.id, true, '?url=https://ignored.test')).status, 400);
  const response = await request(profile.id);
  assert.equal(response.status, 200);
  const revision = getSnapshot(profile.id).profile.revision;
  assert.equal(response.headers.get('X-Config-Revision'), String(revision));
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Disposition')!, /mihomo-\d+\.yaml/);
  const body = await response.text();
  assert.equal(response.headers.get('X-Config-SHA256'), createHash('sha256').update(body).digest('hex'));
  assert.match(body, /^# 未迁移的 Stash 专用区块：http$/m);
  const config = parse(body);
  assert.equal(config.http, undefined);
  assert.equal(config['mixed-port'], 7890);
  assert.deepEqual(config.dns, {
    enable: true, 'respect-rules': true, nameserver: ['1.1.1.1'], 'proxy-server-nameserver': ['8.8.8.8']
  });
  assert.deepEqual(config.rules, [
    'AND,((DOMAIN,foo.example.test),(SRC-IP-CIDR,192.0.2.0/24)),Outlet', 'RULE-SET,domains,REJECT', 'MATCH,DIRECT'
  ]);
  assert.deepEqual(config['proxy-providers'].remote, {
    type: 'http', url: 'https://proxy.example.test/private-feed', header: { 'X-Test': ['proxy-fixture'] }
  });
  assert.equal(config['proxy-providers'][current.name].type, 'file');
  assert.deepEqual(config['rule-providers'].domains, { type: 'inline', behavior: 'domain', payload: ['+.example.test'] });
  assert.deepEqual(config['rule-providers'].local, { type: 'file', path: './local.yaml', behavior: 'classical' });
  assert.deepEqual(config['rule-providers'].remote.header, { 'X-Test': ['a', 'b'] });
  assert.equal(getLatestConfig(profile.id).sha256, old.sha256);
  assert.equal(getLatestConfig(profile.id).revision, old.revision);
});

test('incompatible routing returns a targeted diagnostic rather than a partially working file', async () => {
  const { profile, rules } = createProfile('Stash pre-matching', `
rules:
  - DOMAIN,ads.example.test,REJECT,pre-matching
  - MATCH,DIRECT
`);
  const response = await request(profile.id);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const payload = await response.json();
  assert.ok(payload.issues.some((issue: { code: string; resourceId: number }) =>
    issue.code === 'mihomo.rule' && issue.resourceId === rules[0].id));
});

test('rewritten providers use the enabled managed link and never fall back to the unmodified upstream', async () => {
  const { profile } = createProfile('Managed source');
  const provider = createProxyProvider(profile.id, {
    name: 'managed',
    config: { type: 'http' },
    sourceUrl: 'https://provider.example.test/private-feed',
    sourceHeaders: { 'X-Test': 'private-fixture' },
    rewriteRules: [{ matchName: '^HK-', operation: 'set', field: 'udp', value: true }]
  });
  const id = provider.id;
  const response = await request(profile.id);
  assert.equal(response.status, 200);
  const yaml = await response.text();
  const config = parse(yaml);
  const url = config['proxy-providers'].managed.url;
  assert.match(url, /^https:\/\/forge\.example\.test\/api\/proxy-source\//);
  assert.doesNotMatch(yaml, /private-feed|private-fixture|managed-source\.invalid/);
  setSourceAccess(getDb(), profile.id, id, false);
  const revoked = await request(profile.id);
  assert.equal(revoked.status, 409);
  assert.ok((await revoked.json()).issues.some((issue: { code: string }) => issue.code === 'mihomo.managed-source'));
  setSourceAccess(getDb(), profile.id, id, true);
  const rotated = await request(profile.id);
  assert.equal(rotated.status, 200);
  assert.notEqual(parse(await rotated.text())['proxy-providers'].managed.url, url);
});
