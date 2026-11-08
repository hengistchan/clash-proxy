import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { parse, stringify } from 'yaml';
import { GET as bundle } from '../app/api/profiles/[profileId]/bundle/route';
import { GET as download } from '../app/api/profiles/[profileId]/config_download/route';
import { POST as previewRoute } from '../app/api/profiles/[profileId]/proxy-source-preview/route';
import { GET as subscribe } from '../app/api/config_download/[token]/config.yaml/route';
import { GET as providerRoute } from '../app/api/proxy-source/[capability]/proxies.yaml/route';
import { resetEncryptionCacheForTests } from '../lib/crypto';
import { closeDbForTests, getDb } from '../lib/db';
import { configForToken, getDeliveryStatus, revokeDownloadLink, rotateDownloadLink } from '../lib/delivery';
import { HttpError } from '../lib/http';
import { rotateSourceCapability } from '../lib/managed-source-access';
import { previewImport } from '../lib/revision-comparison';
import { managedProxySource } from '../lib/managed-proxy-source';
import { previewProxySource } from '../lib/proxy-source-preview';
import { transformProxySource } from '../lib/proxy-source-transform';
import { createProfile, createProxyProvider, getSnapshot, importYaml, resetRepositoryForTests, restoreRevision, updateProxyProvider } from '../lib/repository';
import type { ProxyRewriteRule } from '../lib/types';

const directory = mkdtempSync(path.join(tmpdir(), 'forge-source-rewrite-'));
const admin = ['fixture', 'admin'].join('-');
const sourceUrl = 'https://source.example.test/private-feed';
const sourceHeaders = { 'X-Test': 'fixture-private-header' };
const fixture = {
  proxies: [
    { name: 'HK-missing', type: 'ss', server: 'nodes.example.test', port: 443, cipher: 'aes-128-gcm' },
    { name: 'HK-explicit', type: 'ss', udp: false },
    { name: 'HK-other-type', type: 'trojan' },
    { name: 'JP-unmatched', type: 'ss', extra: { mixed: ['a', false] } }
  ]
};
const body = stringify(fixture);
const rules: ProxyRewriteRule[] = [{ matchName: '^HK-', protocol: 'ss', operation: 'fill', field: 'udp', value: true }];
const expectStatus = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;
let dbIndex = 0;
beforeEach(() => {
  closeDbForTests();
  resetRepositoryForTests();
  resetEncryptionCacheForTests();
  process.env.STASH_DB_PATH = path.join(directory, `${++dbIndex}.sqlite3`);
  process.env.STASH_KEY_PATH = path.join(directory, `${dbIndex}.key`);
  process.env.STASH_ADMIN_TOKEN = admin;
  process.env.STASH_PUBLIC_BASE_URL = 'https://forge.example.test';
  delete process.env.STASH_SEED_EXAMPLE;
  delete process.env.STASH_SECRET_KEY;
});
after(() => {
  closeDbForTests();
  rmSync(directory, { recursive: true, force: true });
});

const fixtureSource = (rewriteRules = rules) => ({ name: 'remote', config: { type: 'http', interval: 300, filter: 'HK' }, sourceUrl, sourceHeaders, rewriteRules });
const adminRequest = new Request('http://internal.test/download', { headers: { 'X-Admin-Token': admin } });
const profileContext = (id: number) => ({ params: Promise.resolve({ profileId: String(id) }) });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function readExport(profileId: number) {
  const response = await download(adminRequest, profileContext(profileId));
  assert.equal(response.status, 200);
  const text = await response.text();
  const entry = parse(text)['proxy-providers'].remote;
  assert.match(entry.url, /^https:\/\/forge\.example\.test\/api\/proxy-source\//);
  assert.equal(response.headers.get('X-Config-SHA256'), sha(text));
  return { entry, capability: new URL(entry.url).pathname.split('/')[3], text };
}

test('ordered, protocol-aware patches preserve explicit false and all unrelated fields; preview measures final changes', () => {
  const filled = transformProxySource(body, rules);
  assert.deepEqual(parse(filled.yaml).proxies, [{ ...fixture.proxies[0], udp: true }, ...fixture.proxies.slice(1)]);
  assert.deepEqual(filled.preview, { totalNodes: 4, matchedNodes: 2, changedNodes: 1, examples: [{ node: 1, field: 'udp', before: 'missing', after: true }] });
  const final = transformProxySource(body, [...rules, { ...rules[0], operation: 'set', value: false }]);
  assert.deepEqual(final.preview.examples, [{ node: 1, field: 'udp', before: 'missing', after: false }]);
  assert.equal(final.preview.matchedNodes, 2);
  assert.throws(() => transformProxySource(body, [{ ...rules[0], matchName: '(a)\\1' }]), expectStatus(400));
  assert.throws(() => transformProxySource('proxies: []', rules));
  assert.throws(() => transformProxySource('a: &node {name: node, type: ss}\nproxies: [*node]', rules));
});

test('preview uses saved credentials without writing data and rejects invalid rules before sending a request', async () => {
  const { profile } = createProfile('Preview');
  const provider = createProxyProvider(profile.id, fixtureSource());
  const snapshot = getSnapshot(profile.id);
  let attempts = 0;
  const fetchSource = async (config: Record<string, unknown>) => {
    attempts++;
    assert.equal(config.url, sourceUrl);
    assert.deepEqual(config.headers, sourceHeaders);
    return body;
  };
  const input = { providerId: provider.id, config: {}, rewriteRules: rules };
  const preview = await previewProxySource(profile.id, input, fetchSource);
  assert.equal(preview.changedNodes, 1);
  assert.doesNotMatch(JSON.stringify(preview), /private|HK-missing|nodes\.example/);
  assert.deepEqual(getSnapshot(profile.id), snapshot);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM managed_proxy_source_cache').pluck().get(), 0);
  await assert.rejects(previewProxySource(profile.id, { ...input, rewriteRules: [{ ...rules[0], matchName: '[' }] }, fetchSource), expectStatus(400));
  assert.equal(attempts, 1);
  const unauthenticated = await previewRoute(new Request('http://internal.test/preview', { method: 'POST' }), profileContext(profile.id));
  assert.equal(unauthenticated.status, 401);
});

test('manual YAML, device YAML and ZIP use identical scoped URLs without upstream credentials', async () => {
  const { profile } = createProfile('Managed delivery');
  const managed = createProxyProvider(profile.id, fixtureSource());
  createProxyProvider(profile.id, { name: 'untouched', config: { type: 'http' }, sourceUrl: 'https://unmanaged.example.test/feed' });
  assert.equal(getDeliveryStatus(profile.id).subscriptionPath, null);
  const { entry, capability, text } = await readExport(profile.id);
  assert.equal(entry.headers, undefined);
  assert.equal(entry.interval, 300);
  assert.equal(entry.filter, 'HK');
  assert.equal(parse(text)['proxy-providers'].untouched.url, 'https://unmanaged.example.test/feed');
  assert.doesNotMatch(text, /private-feed|fixture-private-header|managed-source\.invalid/);
  assert.equal(getDeliveryStatus(profile.id).subscriptionPath, null);
  const { subscriptionPath } = rotateDownloadLink(profile.id);
  const token = subscriptionPath!.split('/')[3];
  const subscribed = await subscribe(new Request('http://internal.test' + subscriptionPath), { params: Promise.resolve({ token }) });
  assert.equal(subscribed.status, 200);
  assert.equal((await subscribed.text()).split('\n').slice(1).join('\n'), text);

  const zipped = Buffer.from(await (await bundle(adminRequest, profileContext(profile.id))).arrayBuffer());
  const fileSize = zipped.readUInt32LE(18), fileNameSize = zipped.readUInt16LE(26);
  assert.equal(zipped.subarray(30, 30 + fileNameSize).toString(), 'config.yaml');
  assert.equal(zipped.subarray(30 + fileNameSize, 30 + fileNameSize + fileSize).toString(), text);
  assert.ok(zipped.includes(sha(text)));

  assert.throws(() => configForToken(capability), expectStatus(404));
  await assert.rejects(managedProxySource(token), expectStatus(404));
  const swappedId = capability.replace(`.${managed.id}.`, `.${managed.id + 1}.`);
  const invalid = await providerRoute(new Request(entry.url), { params: Promise.resolve({ capability: swappedId }) });
  assert.equal(invalid.status, 404);
  assert.equal(invalid.headers.get('Cache-Control'), 'no-store');
  assert.equal(invalid.headers.get('Referrer-Policy'), 'no-referrer');
  const legacy = `${profile.id}.${managed.id}.${createHmac('sha256', token)
    .update(`stash-proxy-source:${profile.id}:${managed.id}`).digest('hex')}`;
  assert.equal((await managedProxySource(legacy, async () => body)).stale, false);
  rotateDownloadLink(profile.id);
  await assert.rejects(managedProxySource(legacy), expectStatus(404));
  assert.equal((await readExport(profile.id)).capability, capability);
  revokeDownloadLink(profile.id);
  assert.equal((await readExport(profile.id)).capability, capability);
  assert.equal(getDeliveryStatus(profile.id).subscriptionPath, null);
  assert.equal((await managedProxySource(capability, async () => body)).stale, false);
  rotateSourceCapability(getDb(), profile.id, managed.id);
  await assert.rejects(managedProxySource(capability), expectStatus(404));
  assert.notEqual((await readExport(profile.id)).capability, capability);
});

test('managed requests share one refresh, recover from outage, and never reuse cache for changed credentials', async () => {
  const { profile } = createProfile('Cached delivery');
  const provider = createProxyProvider(profile.id, fixtureSource());
  const { capability } = await readExport(profile.id);
  let clock = 100_000, attempts = 0;
  let answer = body;
  const now = () => clock;
  const fetchSource = async () => { attempts++; return answer; };
  const [first, duplicate] = await Promise.all([
    managedProxySource(capability, fetchSource, now), managedProxySource(capability, fetchSource, now)
  ]);
  assert.deepEqual(duplicate, first);
  assert.equal(attempts, 1);
  assert.equal(first.stale, false);
  const row = getDb().prepare('SELECT yaml_ciphertext FROM managed_proxy_source_cache').pluck().get() as string;
  assert.doesNotMatch(row, /HK-missing|nodes\.example/);
  answer = 'upstream is down';
  clock += 60_001;
  assert.deepEqual(await managedProxySource(capability, fetchSource, now), { yaml: first.yaml, stale: true });
  assert.deepEqual(await managedProxySource(capability, fetchSource, now), { yaml: first.yaml, stale: true });
  assert.equal(attempts, 2);

  updateProxyProvider(profile.id, provider.id, fixtureSource([{ ...rules[0], value: false }]));
  clock += 1;
  assert.deepEqual(await managedProxySource(capability, fetchSource, now), { yaml: first.yaml, stale: true });
  assert.equal(attempts, 3);
  answer = body;
  clock += 60_001;
  const recovered = await managedProxySource(capability, fetchSource, now);
  assert.equal(recovered.stale, false);
  assert.equal(parse(recovered.yaml).proxies[0].udp, false);

  updateProxyProvider(profile.id, provider.id, { ...fixtureSource(), sourceHeaders: { 'X-Test': 'fixture-replaced-header' } });
  answer = 'upstream is down';
  await assert.rejects(managedProxySource(capability, fetchSource, now), expectStatus(502));
  updateProxyProvider(profile.id, provider.id, fixtureSource([]));
  await assert.rejects(managedProxySource(capability, fetchSource, now), expectStatus(404));
  assert.equal(getDb().prepare('SELECT COUNT(*) FROM managed_proxy_source_cache').pluck().get(), 0);
});

test('upstream request finishing after revocation cannot return data or populate the cache', async () => {
  const { profile } = createProfile('Revoke during refresh');
  const provider = createProxyProvider(profile.id, fixtureSource());
  const { capability } = await readExport(profile.id);
  let complete!: (body: string) => void;
  const pending = managedProxySource(capability, () => new Promise((resolve) => { complete = resolve; }));
  rotateSourceCapability(getDb(), profile.id, provider.id);
  complete(body);
  await assert.rejects(pending, expectStatus(404));
  assert.equal(getDb().prepare('SELECT COUNT(*) FROM managed_proxy_source_cache').pluck().get(), 0);
});

test('rewrite rules survive imports of the same source and can be restored from version history', () => {
  const { profile } = createProfile('Source history');
  const provider = createProxyProvider(profile.id, fixtureSource());
  const saved = getSnapshot(profile.id);
  assert.deepEqual(saved.proxyProviders[0].rewriteRules, rules);
  assert.doesNotMatch(JSON.stringify(saved.proxyProviders), /private-feed|fixture-private-header/);
  updateProxyProvider(profile.id, provider.id, fixtureSource([]));
  assert.equal(getSnapshot(profile.id).proxyProviders[0].rewriteRules, undefined);
  restoreRevision(profile.id, saved.profile.revision);
  assert.deepEqual(getSnapshot(profile.id).proxyProviders[0].rewriteRules, rules);
  importYaml(profile.id, 'proxy-providers:\n  remote: {type: http}\nrules: ["MATCH,DIRECT"]');
  assert.deepEqual(getSnapshot(profile.id).proxyProviders[0].rewriteRules, rules);
});

test('managed YAML round-trips only in its own profile and restores the same delivery identity', async () => {
  const { profile } = createProfile('Source round trip');
  const original = createProxyProvider(profile.id, fixtureSource());
  const saved = getSnapshot(profile.id);
  const { capability, text } = await readExport(profile.id);
  const preview = previewImport(profile.id, text);
  assert.equal(preview.checks.stash.state, 'pending');
  assert.equal(preview.changes.totalChanges, 0);
  assert.equal(getSnapshot(profile.id).profile.revision, saved.profile.revision);
  assert.doesNotMatch(JSON.stringify(preview), /private-feed|fixture-private-header|\/api\/proxy-source/);
  assert.throws(() => createProfile('Bad clone', text), expectStatus(409));
  const other = createProfile('Other profile');
  assert.throws(() => previewImport(other.profile.id, text), expectStatus(409));
  assert.throws(() => importYaml(other.profile.id, text), expectStatus(409));
  assert.throws(() => importYaml(profile.id, text + '\nhosts: { changed.test: 192.0.2.2 }', preview.previewFingerprint), expectStatus(409));
  importYaml(profile.id, text, preview.previewFingerprint);
  assert.equal(getSnapshot(profile.id).proxyProviders[0].id, original.id);
  assert.deepEqual(getSnapshot(profile.id).proxyProviders[0].rewriteRules, rules);
  restoreRevision(profile.id, saved.profile.revision);
  assert.equal((await readExport(profile.id)).capability, capability);
  assert.equal((await managedProxySource(capability, async () => body)).stale, false);
});
