import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { parse } from 'yaml';
import { GET as deviceDownload } from '../app/api/config_download/[token]/mihomo.yaml/route';
import { POST as rotate, DELETE as revoke } from '../app/api/profiles/[profileId]/mihomo/download-link/route';
import { GET as stashDownload } from '../app/api/profiles/[profileId]/config_download/route';
import { GET as download } from '../app/api/profiles/[profileId]/mihomo/config_download/route';
import { resetEncryptionCacheForTests } from '../lib/crypto';
import { closeDbForTests, getDb } from '../lib/db';
import { configForToken, getLatestConfig, rotateDownloadLink } from '../lib/delivery';
import { setSourceAccess } from '../lib/managed-source-access';
import { createProfile, createProxyProvider, getSnapshot, importYaml, resetRepositoryForTests, updateProxyProvider } from '../lib/repository';
import { managedProxySource } from '../lib/managed-proxy-source';
import { getMihomoStatus } from '../lib/mihomo-delivery';
import { getShadowrocketStatus, rotateShadowrocketLink, shadowrocketConfigForToken } from '../lib/shadowrocket-delivery';
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

function profileContext(id: number) {
  return { params: Promise.resolve({ profileId: String(id) }) };
}
function adminLinkRequest(id: number, authenticated = true) {
  return new Request(`https://forge.example.test/api/profiles/${id}/mihomo/download-link`, {
    headers: authenticated ? { 'X-Admin-Token': admin } : {}
  });
}
function subscribe(url: string) {
  const token = new URL(url).pathname.split('/')[3];
  return deviceDownload(new Request(url), { params: Promise.resolve({ token }) });
}

test('fixed Mihomo link keeps the last good version, follows manual publishing, and rotates independently', async () => {
  const { profile } = createProfile('Mihomo link lifecycle', 'rules: ["MATCH,DIRECT"]');
  const id = profile.id;
  const ctx = profileContext(id);
  assert.equal((await rotate(adminLinkRequest(id, false), ctx)).status, 401);
  assert.equal((await revoke(adminLinkRequest(id, false), ctx)).status, 401);
  const stash = rotateDownloadLink(id).subscriptionPath!;
  assert.equal((await subscribe(new URL(stash.replace('config.yaml', 'mihomo.yaml'), 'https://forge.example.test').href)).status, 404);
  const response = await rotate(adminLinkRequest(id), ctx);
  assert.equal(response.status, 200);
  const { subscriptionUrl: url } = await response.json();
  assert.match(url, /^https:\/\/forge\.example\.test\/api\/config_download\/[A-Za-z0-9_-]{43}\/mihomo\.yaml$/);
  const first = await subscribe(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  assert.equal(first.headers.get('Referrer-Policy'), 'no-referrer');
  const original = await first.text();

  importYaml(id, 'rules: ["DOMAIN,blocked.test,REJECT,pre-matching", "MATCH,DIRECT"]');
  assert.equal(getMihomoStatus(id).current, false);
  const fallback = await subscribe(url);
  assert.equal(fallback.headers.get('X-Config-Revision'), String(profile.revision));
  assert.equal(await fallback.text(), original);

  changeTargetPublication(getDb(), id, 'mihomo', { action: 'manual', expectedMode: 'auto', expectedPublicationId: null });
  const pinned = getMihomoStatus(id);
  const fixed = importYaml(id, 'rules: ["DOMAIN,new.test,REJECT", "MATCH,DIRECT"]');
  assert.equal(await (await subscribe(url)).text(), original);
  changeTargetPublication(getDb(), id, 'mihomo', { action: 'publish', expectedMode: 'manual', expectedPublicationId: pinned.publicationId! });
  const published = await subscribe(url);
  assert.equal(published.headers.get('X-Config-Revision'), String(fixed.profile.revision));
  assert.match(await published.text(), /DOMAIN,new\.test,REJECT/);
  const latest = getMihomoStatus(id);
  changeTargetPublication(getDb(), id, 'mihomo', { action: 'rollback', expectedMode: 'manual',
    expectedPublicationId: latest.publicationId!, publicationId: pinned.publicationId! });
  assert.equal(await (await subscribe(url)).text(), original);

  const rotated = await rotate(adminLinkRequest(id), ctx);
  const { subscriptionUrl: replacement } = await rotated.json();
  assert.notEqual(replacement, url);
  assert.equal((await subscribe(url)).status, 404);
  assert.equal((await subscribe(replacement)).status, 200);
  assert.equal((await revoke(adminLinkRequest(id), ctx)).status, 204);
  assert.equal((await subscribe(replacement)).status, 404);
  assert.equal(configForToken(stash.split('/')[3]).revision, fixed.profile.revision);
});

test('managed links and node caches are scoped to the published target', async () => {
  const { profile } = createProfile('Managed source');
  const id = profile.id;
  const input = {
    name: 'managed',
    config: { type: 'http' },
    sourceUrl: 'https://provider.example.test/private-feed',
    sourceHeaders: { 'X-Test': 'private-fixture' },
    rewriteRules: [{ matchName: '^HK-', operation: 'set', field: 'udp', value: true }] as const
  };
  const provider = createProxyProvider(id, { ...input, rewriteRules: [...input.rewriteRules] });
  const db = getDb();
  changeTargetPublication(db, id, 'stash', { action: 'manual', expectedMode: 'auto', expectedPublicationId: null });
  updateProxyProvider(id, provider.id, { ...input, rewriteRules: [{ ...input.rewriteRules[0], value: false }] });

  const mihomo = await request(id);
  assert.equal(mihomo.status, 200);
  const yaml = await mihomo.text();
  assert.doesNotMatch(yaml, /private-feed|private-fixture|managed-source\.invalid/);
  const mihomoSource = new URL(parse(yaml)['proxy-providers'].managed.url).pathname.split('/')[3];
  assert.match(mihomoSource, /^m2\./);
  const stashFile = await stashDownload(adminLinkRequest(id), profileContext(id));
  const stashSource = new URL(parse(await stashFile.text())['proxy-providers'].managed.url).pathname.split('/')[3];
  assert.match(stashSource, /^m1\./);
  const upstream = async () => 'proxies: [{name: HK-Node, type: socks5, server: 192.0.2.1, port: 1080}]';
  const [stash, clash] = await Promise.all([
    managedProxySource(stashSource, upstream),
    managedProxySource(mihomoSource, upstream)
  ]);
  assert.equal(parse(stash.yaml).proxies[0].udp, true);
  assert.equal(parse(clash.yaml).proxies[0].udp, false);
  assert.equal(await managedProxySource(stashSource, upstream).then(x => x.yaml), stash.yaml);
  assert.equal(await managedProxySource(mihomoSource, upstream).then(x => x.yaml), clash.yaml);
  setSourceAccess(db, id, provider.id, false, 'mihomo');
  await assert.rejects(managedProxySource(mihomoSource, upstream), { status: 404 });
  assert.equal(await managedProxySource(stashSource, upstream).then(x => x.yaml), stash.yaml);

  // Removing a served source invalidates its capability even if it is later added back.
  setSourceAccess(db, id, provider.id, true, 'mihomo');
  const enabled = await request(id);
  const nextSource = new URL(parse(await enabled.text())['proxy-providers'].managed.url).pathname.split('/')[3];
  updateProxyProvider(id, provider.id, { ...input, rewriteRules: [] });
  updateProxyProvider(id, provider.id, { ...input, rewriteRules: [...input.rewriteRules] });
  await assert.rejects(managedProxySource(nextSource, upstream), { status: 404 });
  assert.equal(await managedProxySource(stashSource, upstream).then(x => x.yaml), stash.yaml);
});

test('v7 upgrade preserves publication IDs, current pointers, and pre-existing device links', async () => {
  const { profile } = createProfile('Migrate v7 publication');
  const id = profile.id;
  const db = getDb();
  const stash = rotateDownloadLink(id).subscriptionPath!;
  const shadow = (await rotateShadowrocketLink(id)).subscriptionPath!;
  for (const target of ['stash', 'shadowrocket'] as const) {
    changeTargetPublication(db, id, target, { action: 'manual', expectedMode: 'auto', expectedPublicationId: null });
  }
  const expectedRows = db.prepare('SELECT * FROM target_publications ORDER BY id').all();
  const expectedModes = db.prepare('SELECT * FROM target_delivery_modes ORDER BY target').all();
  const highest = 50;
  db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'target_publications'").run(highest);
  db.exec(`
    DROP TABLE mihomo_proxy_source_access;
    DROP TABLE mihomo_proxy_source_cache;
    DROP TABLE mihomo_download_links;
    DROP TABLE mihomo_compilations;
    PRAGMA user_version = 7;
  `);
  closeDbForTests();
  resetRepositoryForTests();

  assert.equal(getDb().pragma('user_version', { simple: true }), 8);
  assert.deepEqual(getDb().prepare('SELECT * FROM target_publications ORDER BY id').all(), expectedRows);
  assert.deepEqual(getDb().prepare('SELECT * FROM target_delivery_modes ORDER BY target').all(), expectedModes);
  assert.deepEqual(getDb().pragma('foreign_key_check'), []);
  assert.equal(configForToken(stash.split('/')[3]).revision, profile.revision);
  assert.equal((await shadowrocketConfigForToken(shadow.split('/')[3])).revision, profile.revision);
  assert.equal(getShadowrocketStatus(id).deliveryMode, 'manual');
  assert.equal(getMihomoStatus(id).compiledRevision, profile.revision);
  changeTargetPublication(getDb(), id, 'mihomo', { action: 'manual', expectedMode: 'auto', expectedPublicationId: null });
  assert.equal(getMihomoStatus(id).publicationId, highest + 1);
});
