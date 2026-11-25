import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { parse, stringify } from 'yaml';
import { closeDbForTests, getDb } from '../lib/db';
import { encryptJson, resetEncryptionCacheForTests } from '../lib/crypto';
import { createProfile, createProxyProvider, getCompilationSnapshot, getSnapshot, importYaml, resetRepositoryForTests, updateProxyProvider } from '../lib/repository';
import { configForToken, getLatestConfig, rotateDownloadLink } from '../lib/delivery';
import { getLatestMihomoConfig } from '../lib/mihomo-delivery';
import { classifyConfig } from '../lib/config-import';
import { changeTargetPublication } from '../lib/target-publication';
import { deliveryMode, stashCandidate } from '../lib/target-publication-store';
import { candidateSourceStatus, checkCandidateSources } from '../lib/candidate-source-check';
import { checkRoutingSources, checkedRoutingSnapshot } from '../lib/checked-rule-sources';
import { simulateRouting } from '../lib/routing-analysis';
import { compileShadowrocket } from '../lib/shadowrocket';
import { parseShadowrocketDocument } from '../lib/shadowrocket-import';
import { jsonError } from '../lib/http';
import { GET as diagnostics } from '../app/api/diagnostics/route';

const directory = mkdtempSync(join(tmpdir(), 'forge-optimization-'));
let serial = 0;
beforeEach(() => {
  closeDbForTests(); resetRepositoryForTests(); resetEncryptionCacheForTests();
  process.env.STASH_DB_PATH = join(directory, `${++serial}.sqlite3`);
  process.env.STASH_KEY_PATH = join(directory, `${serial}.key`);
  process.env.STASH_ADMIN_TOKEN = 'optimization-fixture';
  delete process.env.STASH_SECRET_KEY; delete process.env.STASH_SEED_EXAMPLE;
});
after(() => { closeDbForTests(); rmSync(directory, { recursive: true, force: true }); });

test('native header aliases are private, canonical, retained on ordinary edits and explicitly clearable, including legacy data', () => {
  const yaml = stringify({
    'proxy-providers': { remote: { url: 'https://example.test/proxies', header: { Authorization: ['fixture-private-header'] } } },
    'rule-providers': { domains: { url: 'https://example.test/rules', behavior: 'domain', header: { Authorization: ['fixture-private-header'] } } },
    rules: ['MATCH,DIRECT']
  });
  const { profile } = createProfile('Native headers', yaml);
  const visible = getSnapshot(profile.id);
  assert.equal(JSON.stringify(visible).includes('fixture-private-header'), false);
  assert.equal(visible.proxyProviders[0].headersConfigured, true);
  assert.equal(visible.ruleProviders[0].headersConfigured, true);
  const proxy = visible.proxyProviders[0];
  // Simulate a resource written before header normalization existed.
  getDb().prepare('UPDATE proxy_providers SET config_ciphertext = ? WHERE id = ?').run(encryptJson({ url: 'https://example.test/proxies', header: { Authorization: ['fixture-legacy'] } }), proxy.id);
  assert.equal(JSON.stringify(getSnapshot(profile.id)).includes('fixture-legacy'), false);
  updateProxyProvider(profile.id, proxy.id, { name: proxy.name, config: {} });
  assert.deepEqual(getCompilationSnapshot(profile.id).proxyProviders[0].config.headers, { Authorization: ['fixture-legacy'] });
  updateProxyProvider(profile.id, proxy.id, { name: proxy.name, config: {}, clearHeaders: true });
  assert.equal(getSnapshot(profile.id).proxyProviders[0].headersConfigured, false);
  assert.equal(Object.hasOwn(getCompilationSnapshot(profile.id).proxyProviders[0].config, 'header'), false);
  assert.throws(() => createProfile('Conflicting headers', stringify({ 'proxy-providers': { p: { url: 'https://example.test/feed', header: { Authorization: ['one'] }, headers: { Authorization: ['two'] } } } })), /header/);
});

test('Mihomo inline providers survive import and export without becoming missing remote subscriptions', () => {
  const { profile } = createProfile('Inline source');
  const lastStash = getLatestConfig(profile.id);
  const yaml = stringify({
    'proxy-providers': { embedded: { type: 'inline', payload: [{ name: 'node', type: 'ss', server: 'example.test', port: 443, cipher: 'aes-128-gcm', password: 'fixture' }] } },
    'proxy-groups': [{ name: 'Pick', type: 'select', use: ['embedded'] }], rules: ['MATCH,Pick']
  });
  importYaml(profile.id, yaml);
  assert.equal(classifyConfig(yaml).format, 'mihomo');
  assert.equal(getSnapshot(profile.id).proxyProviders[0].sourceType, 'inline');
  assert.equal(parse(getLatestMihomoConfig(profile.id).yaml)['proxy-providers'].embedded.payload[0].name, 'node');
  if (process.env.MIHOMO_TEST_BIN) {
    const work = join(directory, `kernel-${serial}`);
    mkdirSync(work);
    const file = join(work, 'config.yaml');
    writeFileSync(file, getLatestMihomoConfig(profile.id).yaml);
    const result = spawnSync(process.env.MIHOMO_TEST_BIN, ['-t', '-d', work, '-f', file], { encoding: 'utf8', timeout: 20_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.equal(getLatestConfig(profile.id).sha256, lastStash.sha256);
});

test('v8 upgrade adds inspection tables without changing resources or an existing device subscription', () => {
  const { profile } = createProfile('Upgrade v8');
  const snapshot = getSnapshot(profile.id);
  const token = rotateDownloadLink(profile.id).subscriptionPath!.split('/')[3];
  const artifact = configForToken(token);
  getDb().exec(`
    DROP TABLE stash_override_links;
    DROP TABLE stash_overrides;
    DROP TABLE candidate_source_checks;
    DROP TABLE rule_source_checks;
    ALTER TABLE managed_proxy_source_cache DROP COLUMN userinfo_ciphertext;
    ALTER TABLE mihomo_proxy_source_cache DROP COLUMN userinfo_ciphertext;
    PRAGMA user_version = 8;
  `);
  closeDbForTests(); resetRepositoryForTests();
  assert.equal(getDb().pragma('user_version', { simple: true }), 10);
  assert.deepEqual(getSnapshot(profile.id), snapshot);
  assert.deepEqual(configForToken(token), artifact);
  assert.deepEqual(getDb().pragma('foreign_key_check'), []);
});

test('candidate checks certify the new source without changing device output or its fallback cache', async () => {
  const { profile } = createProfile('Candidate');
  const db = getDb();
  changeTargetPublication(db, profile.id, 'stash', { action: 'manual', expectedMode: 'auto', expectedPublicationId: null });
  const pinned = getLatestConfig(profile.id).sha256;
  createProxyProvider(profile.id, { name: 'new-source', config: {}, sourceUrl: 'https://example.test/new', rewriteRules: [{ matchName: '', operation: 'fill', field: 'udp', value: true }] });
  const candidate = stashCandidate(db, profile.id)!;
  const publish = () => changeTargetPublication(db, profile.id, 'stash', { action: 'publish', expectedMode: 'manual', expectedPublicationId: deliveryMode(db, profile.id, 'stash')!.publication_id });
  assert.throws(publish, /检查待发布版|先检查/);
  await checkCandidateSources(db, profile.id, 'stash', candidate, async () => { throw new Error('private URL must not appear'); });
  assert.equal(candidateSourceStatus(db, profile.id, 'stash').state, 'failed');
  assert.throws(publish, /先检查/);
  let count = 0;
  await checkCandidateSources(db, profile.id, 'stash', candidate, async config => {
    assert.equal(config.url, 'https://example.test/new'); count++;
    return stringify({ proxies: [{ name: 'node', type: 'ss' }] });
  });
  assert.equal(count, 1);
  assert.equal(candidateSourceStatus(db, profile.id, 'stash').state, 'ready');
  db.prepare('UPDATE candidate_source_checks SET checked_at = 0').run();
  assert.equal(candidateSourceStatus(db, profile.id, 'stash').state, 'stale');
  assert.throws(publish, /先检查/);
  await checkCandidateSources(db, profile.id, 'stash', candidate, async () => 'proxies: [{name: node, type: ss}]');
  assert.equal(getLatestConfig(profile.id).sha256, pinned);
  assert.equal(db.prepare('SELECT COUNT(*) FROM managed_proxy_source_cache').pluck().get(), 0);
  publish();
  assert.equal(getLatestConfig(profile.id).revision, candidate.revision);
});

test('a candidate changed during remote checking cannot receive a successful check result', async () => {
  const { profile } = createProfile('Concurrent candidate');
  const source = createProxyProvider(profile.id, { name: 'source', config: {}, sourceUrl: 'https://example.test/old', rewriteRules: [{ matchName: '', operation: 'fill', field: 'udp', value: true }] });
  let release!: (text: string) => void;
  const pending = checkCandidateSources(getDb(), profile.id, 'stash', stashCandidate(getDb(), profile.id)!, () => new Promise(resolve => { release = resolve; }));
  updateProxyProvider(profile.id, source.id, { name: source.name, config: {}, sourceUrl: 'https://example.test/new' });
  release('proxies: [{name: node, type: ss}]');
  await assert.rejects(pending, /检查期间发生变化/);
  assert.equal(candidateSourceStatus(getDb(), profile.id, 'stash').state, 'pending');
});

test('routing can use a checked remote classical ruleset and refuses expired or changed-source snapshots', async () => {
  const { profile } = createProfile('Routing snapshots', stringify({
    'rule-providers': { remote: { url: 'https://example.test/rules', behavior: 'classical' } }, rules: ['RULE-SET,remote,REJECT', 'MATCH,DIRECT']
  }));
  const snapshot = getCompilationSnapshot(profile.id);
  assert.equal(simulateRouting(snapshot, { host: 'sub.example.test' }).conclusive, false);
  await checkRoutingSources(snapshot, async () => 'payload: ["DOMAIN-SUFFIX,example.test"]');
  const checked = checkedRoutingSnapshot(snapshot);
  const result = simulateRouting(checked.snapshot, { host: 'sub.example.test' });
  assert.equal(result.conclusive, true); assert.equal(result.candidate?.policy, 'REJECT');
  getDb().prepare('UPDATE rule_source_checks SET checked_at = 0').run();
  assert.equal(simulateRouting(checkedRoutingSnapshot(snapshot).snapshot, { host: 'sub.example.test' }).conclusive, false);
  await checkRoutingSources(snapshot, async () => 'payload: ["DOMAIN-SUFFIX,example.test"]');
  const changed = { ...snapshot, ruleProviders: snapshot.ruleProviders.map(source => ({ ...source, config: { ...source.config, url: 'https://example.test/different' } })) };
  assert.equal(checkedRoutingSnapshot(changed).sourceSnapshots[0].usable, false);
  await checkRoutingSources(snapshot, async () => { throw new Error('outage'); });
  assert.equal(checkedRoutingSnapshot(snapshot).sourceSnapshots[0].usable, false);
});

test('logic and classical analysis keep unsupported conditions uncertain while proving supported matches', () => {
  const { profile } = createProfile('Logical rules', 'rules: ["AND,((DOMAIN-SUFFIX,example.test),(DST-PORT,443)),REJECT", "MATCH,DIRECT"]');
  const snapshot = getSnapshot(profile.id);
  assert.equal(simulateRouting(snapshot, { host: 'sub.example.test', port: 443 }).candidate?.policy, 'REJECT');
  assert.equal(simulateRouting(snapshot, { host: 'sub.example.test' }).conclusive, false);
  const provider = { id: 1, name: 'large', displayName: '', behavior: 'domain', providerType: 'inline' as const, config: {}, sortOrder: 1,
    entries: Array.from({ length: 2000 }, (_, index) => ({ id: index + 1, sortOrder: index + 1, value: `unmatched-${index}.example.test` })) };
  const repeated = { ...snapshot, ruleProviders: [provider], rules: [
    ...Array.from({ length: 60 }, (_, index) => ({ id: index + 1, priority: index + 1, type: 'RULE-SET', payload: 'large', policy: 'REJECT', options: [], enabled: true, note: '' })),
    { id: 61, priority: 61, type: 'MATCH', payload: '', policy: 'DIRECT', options: [], enabled: true, note: '' }
  ] };
  assert.equal(simulateRouting(repeated, { host: 'different.example.test' }).conclusive, false);
});

test('native Trojan and AEAD VMess round-trip TLS and basic WebSocket settings and reject unsupported transport', () => {
  const conf = '[Proxy]\nT = trojan, example.test, 443, password=fixture, sni=example.test, udp-relay=true\nV = vmess, example.test, 443, username=00000000-0000-4000-8000-000000000000, vmess-aead=true, tls=true, sni=example.test, ws=true, ws-path=/socket, ws-headers=Host:example.test\n[Rule]\nFINAL,T\n';
  const { profile } = createProfile('Extended nodes', conf);
  const snapshot = getCompilationSnapshot(profile.id);
  const result = compileShadowrocket(snapshot);
  assert.ok(result.artifact, JSON.stringify(result.issues));
  const roundtrip = parseShadowrocketDocument(result.artifact.conf);
  assert.deepEqual(roundtrip.proxies, parseShadowrocketDocument(conf).proxies);
  const incompatible = { ...snapshot, proxies: snapshot.proxies.map(node => ({ ...node, config: { ...node.config, network: 'grpc' } })) };
  assert.equal(compileShadowrocket(incompatible).artifact, null);
  assert.throws(() => parseShadowrocketDocument(conf.replace('ws=true', 'transport=grpc')), /无法无损转换/);
});

test('online backups include WAL writes and the matching key, verify decryptability, and restore only into a new directory', () => {
  const { profile } = createProfile('Backup fixture');
  const db = getDb();
  db.pragma('wal_autocheckpoint = 0');
  createProxyProvider(profile.id, { name: 'private', config: {}, sourceUrl: 'https://example.test/private' });
  const destination = join(directory, `backup-${serial}`);
  const restored = join(directory, `restored-${serial}`);
  const run = (...args: string[]) => spawnSync(process.execPath, ['Scripts/manage-backup.mjs', ...args], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  let result = run('create', destination);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run('verify', destination).status, 0);
  const backedUp = new Database(join(destination, 'stash-config.sqlite3'), { readonly: true });
  assert.equal(backedUp.prepare('SELECT COUNT(*) FROM proxy_providers').pluck().get(), 1);
  backedUp.close();
  assert.equal(run('create', destination).status, 1);
  assert.equal(run('restore', destination, restored).status, 0);
  assert.equal(run('restore', destination, restored).status, 1);
  const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 10);
  const key = join(destination, ['stash', 'config'].join('-') + '.sqlite3.key');
  writeFileSync(key, Buffer.alloc(32));
  manifest.keySha256 = createHash('sha256').update(Buffer.alloc(32)).digest('hex');
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest));
  result = run('verify', destination);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes('example.test'), false);
});

test('diagnostics require authentication and unexpected errors expose only a correlation ID and safe classification', async () => {
  assert.equal((await diagnostics(new Request('https://forge.example.test/api/diagnostics'))).status, 401);
  const response = await diagnostics(new Request('https://forge.example.test/api/diagnostics', { headers: { 'X-Admin-Token': 'optimization-fixture' } }));
  assert.equal(response.status, 200);
  const messages: string[] = [];
  const original = console.error;
  console.error = value => { messages.push(String(value)); };
  try {
    const failed = jsonError(new Error('https://example.test/private?token=fixture'));
    const body = await failed.json();
    assert.match(body.requestId, /^[a-f\d-]{36}$/);
    assert.equal(failed.headers.get('X-Request-ID'), body.requestId);
    assert.equal(messages.join('').includes('example.test'), false);
    assert.equal(JSON.parse(messages[0]).category, 'unexpected');
  } finally { console.error = original; }
});
