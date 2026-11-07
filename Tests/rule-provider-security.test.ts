import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import { closeDbForTests, getDb } from '../lib/db';
import { decryptJson, encryptJson, resetEncryptionCacheForTests } from '../lib/crypto';
import { getDeliveryStatus, getLatestConfig, configForToken, rotateDownloadLink } from '../lib/delivery';
import { exportProfile, type ExportResult } from '../lib/exporter';
import { CONFIG_COMPILER_VERSION } from '../lib/artifact-semantics';
import { GET as managerDownload } from '../app/api/profiles/[profileId]/config_download/route';
import { GET as deviceDownload } from '../app/api/config_download/[token]/config.yaml/route';
import { HttpError } from '../lib/http';
import type { RuleProviderInput } from '../lib/rule-provider-source';
import type { JsonValue } from '../lib/types';
import {
  createRuleProvider, getActiveProfile, getCompilationSnapshot, getSnapshot, importYaml,
  listRevisions, resetRepositoryForTests, restoreRevision, updateRuleProvider
} from '../lib/repository';
import { validateSnapshot } from '../lib/validation';
import { POST as createRoute, GET as listRoute } from '../app/api/profiles/[profileId]/[resource]/route';
import { GET as itemRoute, PUT as updateRoute } from '../app/api/profiles/[profileId]/[resource]/[itemId]/route';
import { GET as snapshotRoute } from '../app/api/profiles/[profileId]/snapshot/route';
import { POST as restoreRoute } from '../app/api/profiles/[profileId]/revisions/[revision]/restore/route';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'forge-rule-provider-'));
const source = 'https://rules.example.test/private?token=rule-source-fixture';
const header = 'Bearer rule-header-fixture';
const admin = 'rule-provider-test-admin';
let sequence = 0;
beforeEach(() => {
  closeDbForTests(); resetRepositoryForTests(); resetEncryptionCacheForTests();
  process.env.STASH_DB_PATH = path.join(temporary, `${++sequence}.sqlite3`);
  process.env.STASH_KEY_PATH = path.join(temporary, `${sequence}.key`);
  process.env.STASH_ADMIN_TOKEN = admin;
  delete process.env.STASH_SECRET_KEY; delete process.env.STASH_SEED_EXAMPLE;
});
after(() => { closeDbForTests(); rmSync(temporary, { recursive: true, force: true }); });
const input = () => ({ name: 'private-rules', behavior: 'domain', providerType: 'remote' as const,
  config: { path: './rules/private.yaml', format: 'yaml', interval: 3600 }, entries: [] as string[],
  sourceUrl: source, sourceHeaders: { Authorization: header } });
function redacted(value: unknown) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(source), false);
  assert.equal(text.includes(header), false);
  assert.equal(text.includes('rule-source-fixture'), false);
  assert.equal(text.includes('rule-header-fixture'), false);
}
function request(profileId: number, method = 'GET', body?: unknown) {
  return new Request('http://localhost/api', { method, headers: {
    'X-Admin-Token': admin, 'Content-Type': 'application/json',
    'If-Match': `"${getSnapshot(profileId).profile.revision}"`
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('remote rule credentials are encrypted, redacted, preserved by ordinary edits and exported only in delivery', () => {
  const profile = getActiveProfile();
  const provider = createRuleProvider(profile.id, input());
  assert.equal(provider.sourceConfigured, true); assert.equal(provider.headersConfigured, true);
  redacted(provider); redacted(getSnapshot(profile.id));
  assert.equal(provider.config.url, undefined); assert.equal(provider.config.headers, undefined);
  updateRuleProvider(profile.id, provider.id, { name: provider.name, behavior: 'domain', providerType: 'remote', config: { interval: 7200 }, entries: [] });
  const result = parse(getLatestConfig(profile.id).yaml)['rule-providers'][provider.name];
  assert.equal(result.url, source); assert.equal(result.headers.Authorization, header);
  assert.equal(result.interval, 7200); assert.equal(result.type, undefined);
  assert.equal(result.payload, undefined);
  closeDbForTests(); resetRepositoryForTests(); resetEncryptionCacheForTests();
  redacted(getSnapshot(profile.id));
  assert.equal(parse(getLatestConfig(profile.id).yaml)['rule-providers'][provider.name].url, source);
  assert.equal(readFileSync(process.env.STASH_DB_PATH!).includes('rule-source-fixture'), false);
});

test('source conflicts fail atomically instead of publishing rules Stash would silently ignore', () => {
  const profile = getActiveProfile();
  const before = getSnapshot(profile.id), history = listRevisions(profile.id), artifact = getLatestConfig(profile.id);
  const conflicts: RuleProviderInput[] = [
    { ...input(), config: { type: 'inline' } },
    { ...input(), config: { payload: ['+.discarded.test'] } },
    { ...input(), entries: ['+.discarded.test'] },
    { ...input(), providerType: 'inline' as const, sourceUrl: undefined, sourceHeaders: undefined, config: { url: source } },
    { ...input(), providerType: 'inline' as const, sourceUrl: undefined, sourceHeaders: undefined, config: { path: './rules/ignored', format: 'yaml' } },
    { ...input(), providerType: 'local' as const, sourceUrl: undefined, sourceHeaders: undefined, config: { url: source, path: './rules/local' } }
  ];
  for (const invalid of conflicts) {
    assert.throws(() => createRuleProvider(profile.id, invalid), (error) => error instanceof HttpError && error.status === 400);
    assert.deepEqual(getSnapshot(profile.id), before); assert.deepEqual(listRevisions(profile.id), history);
    assert.deepEqual(getLatestConfig(profile.id), artifact);
  }
});

test('existing inconsistent sources block compilation and keep device links on the last successful version', () => {
  const profile = getActiveProfile(), provider = createRuleProvider(profile.id, input());
  const artifact = getLatestConfig(profile.id);
  const link = rotateDownloadLink(profile.id).subscriptionPath!;
  getDb().prepare('UPDATE rule_providers SET config_ciphertext = ? WHERE id = ?').run(encryptJson({ type: 'inline', url: source }), provider.id);
  getDb().prepare('UPDATE profiles SET revision = revision + 1 WHERE id = ?').run(profile.id);
  const snapshot = getCompilationSnapshot(profile.id);
  assert.equal(validateSnapshot(snapshot).issues.some((issue) => issue.code === 'rule-provider.source-conflict'), true);
  assert.throws(() => exportProfile(snapshot), (error) => error instanceof HttpError && error.status === 409);
  assert.equal(getDeliveryStatus(profile.id).current, false);
  assert.equal(getLatestConfig(profile.id).revision, artifact.revision);
  assert.equal(configForToken(link.split('/')[3]).yaml, artifact.yaml);
  updateRuleProvider(profile.id, provider.id, { name: provider.name, behavior: 'domain', providerType: 'remote', config: {}, entries: [] });
  assert.equal(getDeliveryStatus(profile.id).current, true);
  assert.equal(parse(getLatestConfig(profile.id).yaml)['rule-providers'][provider.name].type, undefined);
});

test('switching source types removes remote secrets, while inline exports only the supported fields', () => {
  const profile = getActiveProfile(), provider = createRuleProvider(profile.id, input());
  updateRuleProvider(profile.id, provider.id, { name: provider.name, behavior: 'domain', providerType: 'inline', config: {}, entries: ['+.example.test'] });
  assert.deepEqual(parse(getLatestConfig(profile.id).yaml)['rule-providers'][provider.name], { type: 'inline', behavior: 'domain', payload: ['+.example.test'] });
  updateRuleProvider(profile.id, provider.id, { name: provider.name, behavior: 'domain', providerType: 'local', config: { path: './rules/local.yaml', format: 'yaml' }, entries: [] });
  const local = parse(getLatestConfig(profile.id).yaml)['rule-providers'][provider.name];
  assert.deepEqual(local, { path: './rules/local.yaml', format: 'yaml', behavior: 'domain' });
  const pending = updateRuleProvider(profile.id, provider.id, { name: provider.name, behavior: 'domain', providerType: 'remote', config: { path: './rules/cache.yaml' }, entries: [] });
  assert.equal(pending.sourceConfigured, false);
  assert.equal(getDeliveryStatus(profile.id).current, false);
});

test('clearing sources and restoring history reproduce exact credentials without DTO leaks', () => {
  const profile = getActiveProfile(), provider = createRuleProvider(profile.id, input());
  const originalRevision = getSnapshot(profile.id).profile.revision;
  const originalArtifact = getLatestConfig(profile.id);
  const pending = updateRuleProvider(profile.id, provider.id, { name: provider.name, behavior: 'domain', providerType: 'remote', config: {}, entries: [], clearSource: true, clearHeaders: true });
  assert.equal(pending.sourceConfigured, false); assert.equal(pending.headersConfigured, false);
  const clearedRevision = getSnapshot(profile.id).profile.revision;
  assert.equal(getLatestConfig(profile.id).revision, originalArtifact.revision);
  const restored = restoreRevision(profile.id, originalRevision);
  redacted(restored);
  assert.equal(restored.ruleProviders[0].sourceConfigured, true);
  assert.equal(parse(getLatestConfig(profile.id).yaml)['rule-providers'][provider.name].url, source);
  const cleared = restoreRevision(profile.id, clearedRevision);
  assert.equal(cleared.ruleProviders[0].sourceConfigured, false);
  assert.equal(cleared.ruleProviders[0].headersConfigured, false);
  redacted(cleared);
});

test('imports reject conflicting source declarations and preserve valid rule credentials and explicit file sources', () => {
  const profile = getActiveProfile(), before = getSnapshot(profile.id);
  for (const sourceFields of [`type: inline, url: "${source}", payload: [+.example.test]`, `type: file, url: "${source}", path: ./rules/a`]) {
    assert.throws(() => importYaml(profile.id, `rule-providers: {a: {behavior: domain, ${sourceFields}}}\nrules: ["MATCH,DIRECT"]`), (error) => error instanceof HttpError && error.status === 400);
    assert.deepEqual(getSnapshot(profile.id), before);
  }
  const imported = importYaml(profile.id, `rule-providers:\n  remote: {behavior: domain, url: "${source}", path: ./rules/cache, headers: {Authorization: "${header}"}}\n  local: {behavior: domain, path: ./rules/local}\nrules: ["MATCH,DIRECT"]`);
  redacted(imported); assert.equal(imported.ruleProviders[0].providerType, 'remote'); assert.equal(imported.ruleProviders[1].providerType, 'local');
  const exported = parse(getLatestConfig(profile.id).yaml)['rule-providers'];
  assert.equal(exported.remote.url, source); assert.equal(exported.remote.headers.Authorization, header);
  assert.equal(exported.local.url, undefined);
});

test('ordinary create, update, list, item, snapshot and restoration APIs never serialize rule source secrets', async () => {
  const profile = getActiveProfile();
  const context = { params: Promise.resolve({ profileId: String(profile.id), resource: 'rule-providers' }) };
  const created = await createRoute(request(profile.id, 'POST', input()), context);
  assert.equal(created.status, 201);
  const provider = await created.json(); redacted(provider);
  const revision = getSnapshot(profile.id).profile.revision;
  const itemContext = { params: Promise.resolve({ profileId: String(profile.id), resource: 'rule-providers', itemId: String(provider.id) }) };
  const updated = await updateRoute(request(profile.id, 'PUT', { name: provider.name, behavior: 'domain', providerType: 'remote', config: { interval: 7200 }, entries: [] }), itemContext);
  const responses = [updated, await listRoute(request(profile.id), context), await itemRoute(request(profile.id), itemContext), await snapshotRoute(request(profile.id), { params: Promise.resolve({ profileId: String(profile.id) }) }), await restoreRoute(request(profile.id, 'POST'), { params: Promise.resolve({ profileId: String(profile.id), revision: String(revision) }) })];
  for (const response of responses) { assert.equal(response.status, 200); redacted(await response.json()); }
});


test('upgrading rejects unsafe previously compiled artifacts on both management and device delivery', async () => {
  const profile = getActiveProfile(), provider = createRuleProvider(profile.id, input());
  const original = getLatestConfig(profile.id);
  const token = rotateDownloadLink(profile.id).subscriptionPath!.split('/')[3];
  const { compilerVersion: _version, ...legacy } = original;
  const yaml = `rule-providers:\n  private-rules:\n    behavior: domain\n    type: inline\n    url: "${source}"\nrules: ["MATCH,DIRECT"]\n`;
  getDb().prepare('UPDATE compiled_configs SET artifact_ciphertext = ? WHERE profile_id = ?').run(encryptJson({ ...legacy, yaml } as unknown as JsonValue), profile.id);
  getDb().prepare('UPDATE rule_providers SET config_ciphertext = ? WHERE id = ?').run(encryptJson({ type: 'inline', url: source }), provider.id);
  assert.throws(() => configForToken(token), (error) => error instanceof HttpError && error.status === 409);
  const device = await deviceDownload(new Request(`http://localhost/api/config_download/${token}/config.yaml`), { params: Promise.resolve({ token }) });
  const manager = await managerDownload(request(profile.id), { params: Promise.resolve({ profileId: String(profile.id) }) });
  for (const response of [device, manager]) { assert.equal(response.status, 409); redacted(await response.json()); }
  assert.equal(getDeliveryStatus(profile.id).compiledRevision, null);
  assert.equal(getDeliveryStatus(profile.id).current, false);
});

test('compiler upgrades keep a semantically valid legacy artifact when the current draft is invalid', () => {
  const profile = getActiveProfile(), provider = createRuleProvider(profile.id, input());
  const original = getLatestConfig(profile.id);
  const token = rotateDownloadLink(profile.id).subscriptionPath!.split('/')[3];
  const { compilerVersion: _version, ...legacy } = original;
  getDb().prepare('UPDATE compiled_configs SET artifact_ciphertext = ? WHERE profile_id = ?').run(encryptJson(legacy as unknown as JsonValue), profile.id);
  getDb().prepare('UPDATE rule_providers SET config_ciphertext = ? WHERE id = ?').run(encryptJson({ type: 'inline', url: source }), provider.id);
  getDb().prepare('UPDATE profiles SET revision = revision + 1 WHERE id = ?').run(profile.id);
  assert.equal(configForToken(token).yaml, original.yaml);
  assert.equal(getLatestConfig(profile.id).yaml, original.yaml);
  assert.equal(getDeliveryStatus(profile.id).compiledRevision, original.revision);
  assert.equal(getDeliveryStatus(profile.id).current, false);
});

test('safe current artifacts recompile under the current compiler without inventing a profile revision', () => {
  const profile = getActiveProfile(); createRuleProvider(profile.id, input());
  const original = getLatestConfig(profile.id);
  const { compilerVersion: _version, ...legacy } = original;
  getDb().prepare('UPDATE compiled_configs SET artifact_ciphertext = ? WHERE profile_id = ?').run(encryptJson(legacy as unknown as JsonValue), profile.id);
  const result = getLatestConfig(profile.id);
  assert.equal(result.revision, original.revision); assert.equal(result.compilerVersion, CONFIG_COMPILER_VERSION);
  const stored = getDb().prepare('SELECT artifact_ciphertext FROM compiled_configs WHERE profile_id = ?').get(profile.id) as { artifact_ciphertext: string };
  assert.equal(decryptJson<ExportResult>(stored.artifact_ciphertext).compilerVersion, CONFIG_COMPILER_VERSION);
});
