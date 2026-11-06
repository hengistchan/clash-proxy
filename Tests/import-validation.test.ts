import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import { closeDbForTests } from '../lib/db';
import { resetEncryptionCacheForTests } from '../lib/crypto';
import { configForToken, getLatestConfig, rotateDownloadLink } from '../lib/delivery';
import { HttpError } from '../lib/http';
import {
  createProfile,
  createProxyProvider,
  getActiveProfile,
  getSnapshot,
  importYaml,
  listProfiles,
  listRevisions,
  resetRepositoryForTests,
  restoreRevision,
  updateProxyProvider
} from '../lib/repository';
import { validateSnapshot } from '../lib/validation';
import { parseYamlDocument } from '../lib/yaml-import';
import { POST as importRoute } from '../app/api/profiles/[profileId]/import/route';
import { PUT as settingsRoute } from '../app/api/profiles/[profileId]/settings/route';
import { PUT as advancedRoute } from '../app/api/profiles/[profileId]/advanced/route';

const temp = mkdtempSync(path.join(os.tmpdir(), 'forge-import-'));
let sequence = 0;
beforeEach(() => {
  closeDbForTests();
  resetRepositoryForTests();
  resetEncryptionCacheForTests();
  process.env.STASH_DB_PATH = path.join(temp, `${++sequence}.sqlite3`);
  process.env.STASH_KEY_PATH = path.join(temp, `${sequence}.key`);
  delete process.env.STASH_SEED_EXAMPLE;
  delete process.env.STASH_SECRET_KEY;
  delete process.env.STASH_ADMIN_TOKEN;
});
after(() => {
  closeDbForTests();
  rmSync(temp, { recursive: true, force: true });
});

const malformed = [
  'rules: MATCH,REJECT',
  'rules: null',
  'rules: [true]',
  'rules: ["not-a-rule"]',
  'proxies: {}',
  'proxies: [null]',
  'proxies: [{ name: "", type: ss }]',
  'proxies: [{ name: x, type: 42 }]',
  'proxies: [{ name: x, type: ss }, { name: x, type: ss }]',
  'proxy-groups: {}',
  'proxy-groups: [{ name: x, type: select, proxies: DIRECT }]',
  'proxy-groups: [{ name: x, type: select, use: [true] }]',
  'proxies: [{ name: x, type: ss }]\nproxy-groups: [{ name: x, type: select }]',
  'proxy-providers: []',
  'proxy-providers: { private: null }',
  'proxy-providers: { private: { url: [https://provider.test/private] } }',
  'proxy-providers: { private: { headers: { Authorization: true } } }',
  'rule-providers: []',
  'rule-providers: { private: "https://provider.test/private" }',
  'rule-providers: { private: { type: inline, payload: "example.test" } }',
  'rule-providers: { private: { type: inline, payload: [true] } }',
  'dns: []',
  'hosts: []',
  'hosts: { app.test: [1.1.1.1] }',
  'mode: invalid',
  'mode: [rule]',
  'log-level: true',
  'ipv6: "false"',
  'custom: .nan',
  'custom: !!binary aGVsbG8=',
  'custom: &recursive [*recursive]',
  'rules: []\nrules: ["MATCH,REJECT"]'
];

test('malformed imports never replace resources, revisions or device downloads', () => {
  const profile = getActiveProfile();
  importYaml(profile.id, 'rules: ["DOMAIN,app.test,REJECT", "MATCH,DIRECT"]');
  const before = getSnapshot(profile.id);
  const history = listRevisions(profile.id);
  const artifact = getLatestConfig(profile.id);
  const token = rotateDownloadLink(profile.id).subscriptionPath!.split('/')[3];

  for (const yaml of malformed) {
    assert.throws(() => importYaml(profile.id, yaml), (error) => error instanceof HttpError && error.status === 400, yaml);
    assert.deepEqual(getSnapshot(profile.id), before, yaml);
    assert.deepEqual(listRevisions(profile.id), history, yaml);
    assert.deepEqual(getLatestConfig(profile.id), artifact, yaml);
    assert.equal(configForToken(token).yaml, artifact.yaml, yaml);
  }
});

test('failed initial imports roll back profile creation', () => {
  const before = listProfiles();
  assert.throws(() => createProfile('Broken import', 'rules: MATCH,REJECT'), /rules/);
  assert.deepEqual(listProfiles(), before);
});

test('YAML parse failures report location without echoing source credentials', () => {
  const secret = 'https://provider.test/private?token=sensitive-import-value';
  for (const yaml of [`url: ${secret}\nurl: ${secret}`, `url: [${secret}`, `custom: !unknown ${secret}`]) {
    assert.throws(() => parseYamlDocument(yaml), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      assert.match(error.message, /line \d+, column \d+/);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes('sensitive-import-value'), false);
      return true;
    });
  }
});

test('valid imports preserve supported fields, aliases, private providers and advanced values', () => {
  const yaml = `mode: rule
log-level: warning
ipv6: false
dns:
  nameserver: &resolvers [1.1.1.1, https://dns.test/dns-query]
  fallback: *resolvers
hosts: { app.test: 192.0.2.1 }
proxies:
  - { name: node, type: ss, server: node.test, port: 443, cipher: aes-128-gcm, password: secret }
proxy-providers:
  private:
    url: https://provider.test/a?token=private
    headers: { Authorization: [Bearer-private] }
    path: ./providers/a.yaml
    interval: 3600
proxy-groups:
  - { name: Proxy, type: select, proxies: [node, DIRECT], use: [private] }
rule-providers:
  local-rules: { type: inline, behavior: domain, payload: [+.example.test] }
rules: ["RULE-SET,local-rules,Proxy", "MATCH,DIRECT"]
custom: { enabled: false, threshold: 0, label: "", nullable: null, sequence: [true, 2, text] }
`;
  const profile = getActiveProfile();
  const snapshot = importYaml(profile.id, yaml);
  assert.equal(validateSnapshot(snapshot).valid, true);
  assert.equal(JSON.stringify(snapshot.proxyProviders).includes('token=private'), false);
  assert.deepEqual(parse(getLatestConfig(profile.id).yaml), parse(yaml));
});

test('semantic errors remain editable drafts while the last successful artifact stays available', () => {
  const profile = getActiveProfile();
  const before = getLatestConfig(profile.id);
  const snapshot = importYaml(profile.id, 'rules: ["DOMAIN,app.test,missing-policy", "MATCH,DIRECT"]');
  assert.equal(validateSnapshot(snapshot).valid, false);
  assert.equal(snapshot.rules[0].policy, 'missing-policy');
  assert.equal(getLatestConfig(profile.id).revision, before.revision);
});

test('import and save APIs validate private source fields without disclosing them', async () => {
  const profile = getActiveProfile();
  const before = getLatestConfig(profile.id);
  const secret = 'file:///private/provider?token=private-import-credential';
  const context = { params: Promise.resolve({ profileId: String(profile.id) }) };
  const request = (body: unknown) => new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const imported = await importRoute(request({ yaml: `proxy-providers:\n  private:\n    url: ${secret}\nrules: ["MATCH,DIRECT"]` }), context);
  const settings = await settingsRoute(request({ mode: 'rule', logLevel: 'silent', settings: { dns: {} } }), context);
  const advanced = await advancedRoute(request({ sections: [] }), context);
  for (const response of [imported, settings, advanced]) {
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.validation.valid, false);
    assert.equal(body.validation.issues.some((issue: { code: string }) => issue.code === 'proxy-provider.url-invalid'), true);
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(JSON.stringify(body).includes('private-import-credential'), false);
  }
  assert.equal(getLatestConfig(profile.id).revision, before.revision);
});

test('history restores missing or cleared credentials exactly instead of merging current sources', () => {
  const profile = getActiveProfile();
  const pending = createProxyProvider(profile.id, { name: 'private', sourceType: 'remote', config: { path: './providers/private.yaml' } });
  const missingRevision = getSnapshot(profile.id).profile.revision;
  updateProxyProvider(profile.id, pending.id, {
    name: 'private', sourceUrl: 'https://provider.test/a', sourceHeaders: { Authorization: 'original-header' }, config: { path: './providers/private.yaml' }
  });
  const lastSuccessful = getLatestConfig(profile.id);
  const restored = restoreRevision(profile.id, missingRevision);
  assert.equal(restored.proxyProviders[0].sourceConfigured, false);
  assert.equal(restored.proxyProviders[0].headersConfigured, false);
  assert.equal(validateSnapshot(restored).valid, false);
  assert.equal(getLatestConfig(profile.id).revision, lastSuccessful.revision);

  const provider = restored.proxyProviders[0];
  updateProxyProvider(profile.id, provider.id, { name: 'private', sourceUrl: 'https://provider.test/b', sourceHeaders: { Authorization: 'new-header' }, config: {} });
  updateProxyProvider(profile.id, provider.id, { name: 'private', clearSource: true, clearHeaders: true, config: {} });
  const clearedRevision = getSnapshot(profile.id).profile.revision;
  updateProxyProvider(profile.id, provider.id, { name: 'private', sourceUrl: 'https://provider.test/c', sourceHeaders: { Authorization: 'latest-header' }, config: {} });
  const cleared = restoreRevision(profile.id, clearedRevision);
  assert.equal(cleared.proxyProviders[0].sourceConfigured, false);
  assert.equal(cleared.proxyProviders[0].headersConfigured, false);
  assert.equal(validateSnapshot(cleared).valid, false);
});

test('configuration diagnostics identify their editable resource or section', () => {
  const profile = getActiveProfile();
  const snapshot = importYaml(profile.id, 'dns: { nameserver-policy: { "rule-set:missing": [1.1.1.1] } }\ncustom: { rules: "rule-set:missing" }\nproxy-groups: [{name: a, type: select, proxies: [b]}, {name: b, type: select, proxies: [a]}]\nrules: []');
  const issues = validateSnapshot(snapshot).issues;
  assert.equal(issues.find((item) => item.code === 'rule.match-count')?.resource, 'rule');
  assert.equal(issues.find((item) => item.code === 'rule.match-terminal')?.resource, 'rule');
  assert.equal(issues.find((item) => item.code === 'dns.ruleset-missing')?.resource, 'settings');
  const advanced = issues.find((item) => item.code === 'advanced.ruleset-missing');
  assert.equal(advanced?.resource, 'advanced');
  assert.equal(advanced?.resourceId, snapshot.advancedSections[0].id);
  const cycle = issues.find((item) => item.code === 'group.cycle');
  assert.equal(cycle?.resource, 'proxy-group');
  assert.equal(cycle?.resourceId, snapshot.proxyGroups[0].id);
});
