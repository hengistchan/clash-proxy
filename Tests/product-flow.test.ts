import assert from 'node:assert/strict';
import type { JsonValue } from '../lib/types';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { closeDbForTests, getDb } from '../lib/db';
import { resetEncryptionCacheForTests } from '../lib/crypto';
import {
  createProfile,
  getActiveProfile,
  getSnapshot,
  getCompilationSnapshot,
  createProxyProvider,
  updateProxyProvider,
  createRule,
  updateRule,
  importYaml,
  resetRepositoryForTests,
  restoreRevision,
  saveSettings,
  createRuleProvider
} from '../lib/repository';
import {
  getDeliveryStatus,
  getLatestConfig,
  rotateDownloadLink,
  revokeDownloadLink,
  configForToken
} from '../lib/delivery';
import { validateSnapshot } from '../lib/validation';
import { cidrContains, simulateRouting } from '../lib/routing-analysis';
import { GET as download } from '../app/api/profiles/[profileId]/config_download/route';
import { GET as legacy } from '../app/api/route';
import { GET as subscribe } from '../app/api/config_download/[token]/config.yaml/route';

const temp = mkdtempSync(path.join(os.tmpdir(), 'forge-product-'));
const secretA = 'https://provider.test/a?token=private-a';
const secretB = 'https://provider.test/b?token=private-b';
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
function tokenFrom(link: string) {
  return link.split('/')[3];
}

test('fresh installations and new configurations start without mandatory demo resources', () => {
  const p = getActiveProfile(),
    snapshot = getSnapshot(p.id);
  assert.equal(snapshot.proxyProviders.length, 0);
  assert.equal(snapshot.proxyGroups.length, 0);
  assert.equal(snapshot.ruleProviders.length, 0);
  assert.equal(getDeliveryStatus(p.id).current, true);
  assert.deepEqual(parse(getLatestConfig(p.id).yaml).rules, ['MATCH,DIRECT']);
  const other = createProfile('Only my settings');
  assert.equal(other.proxyProviders.length, 0);
  assert.equal(getDeliveryStatus(other.profile.id).current, true);
});

test('multiple provider secrets are isolated, redacted, encrypted and survive restart and metadata edits', () => {
  const p = getActiveProfile();
  const a = createProxyProvider(p.id, {
    name: 'a',
    sourceUrl: secretA,
    sourceHeaders: { Authorization: 'Bearer private-header' },
    config: { interval: 60 }
  });
  const b = createProxyProvider(p.id, {
    name: 'b',
    sourceUrl: secretB,
    config: {}
  });
  assert.equal(a.sourceConfigured, true);
  assert.equal(a.headersConfigured, true);
  assert.equal(JSON.stringify(a).includes(secretA), false);
  assert.equal(
    JSON.stringify(getSnapshot(p.id)).includes('private-header'),
    false
  );
  updateProxyProvider(p.id, a.id, { name: 'a', config: { interval: 120 } });
  closeDbForTests();
  resetRepositoryForTests();
  resetEncryptionCacheForTests();
  const config = parse(getLatestConfig(p.id).yaml);
  assert.equal(config['proxy-providers'].a.url, secretA);
  assert.equal(config['proxy-providers'].b.url, secretB);
  assert.equal(
    config['proxy-providers'].a.headers.Authorization,
    'Bearer private-header'
  );
  assert.equal(config['proxy-providers'].a.interval, 120);
  assert.equal(
    getSnapshot(p.id).proxyProviders.find((item) => item.id === b.id)
      ?.sourceConfigured,
    true
  );
  for (const suffix of ['', '-wal']) {
    const file = process.env.STASH_DB_PATH + suffix;
    if (existsSync(file))
      for (const value of [secretA, secretB, 'private-header'])
        assert.equal(readFileSync(file).includes(value), false);
  }
});

test('a remote cache path is not treated as a configured subscription; explicit local sources work', () => {
  const p = getActiveProfile();
  const provider = createProxyProvider(p.id, {
    name: 'remote',
    sourceType: 'remote',
    config: { path: './cache/a.yaml' }
  });
  assert.equal(provider.sourceConfigured, false);
  assert.equal(validateSnapshot(getSnapshot(p.id)).valid, false);
  assert.equal(getDeliveryStatus(p.id).current, false);
  updateProxyProvider(p.id, provider.id, {
    name: 'remote',
    sourceType: 'local',
    config: { path: './cache/a.yaml' }
  });
  assert.equal(getDeliveryStatus(p.id).current, true);
  assert.equal(
    parse(getLatestConfig(p.id).yaml)['proxy-providers'].remote.url,
    undefined
  );
});

test('invalid drafts preserve last good downloads and a repaired draft updates existing device links', async () => {
  const p = getActiveProfile();
  const before = getLatestConfig(p.id);
  const rule = createRule(p.id, {
    type: 'DOMAIN',
    payload: 'app.test',
    policy: 'missing-group'
  });
  assert.equal(getSnapshot(p.id).rules.length, 2);
  assert.equal(getDeliveryStatus(p.id).current, false);
  assert.equal(getLatestConfig(p.id).revision, before.revision);
  const link = rotateDownloadLink(p.id).subscriptionPath!;
  const token = tokenFrom(link);
  assert.equal(configForToken(token).revision, before.revision);
  updateRule(p.id, rule.id, {
    type: 'DOMAIN',
    payload: 'app.test',
    policy: 'DIRECT'
  });
  assert.equal(getDeliveryStatus(p.id).current, true);
  assert.equal(
    configForToken(token).revision,
    getSnapshot(p.id).profile.revision
  );
  const request = new Request(`http://localhost${link}`);
  const response = await subscribe(request, {
    params: Promise.resolve({ token })
  });
  assert.equal(response.status, 200);
  assert.ok(
    (await response.text()).startsWith(`#SUBSCRIBED http://localhost${link}\n`)
  );
  const rotated = tokenFrom(rotateDownloadLink(p.id).subscriptionPath!);
  assert.throws(() => configForToken(token), /not found/);
  revokeDownloadLink(p.id);
  assert.throws(() => configForToken(rotated), /not found/);
});

test('management downloads require configured auth, reject legacy parameters, and old public API is retired', async () => {
  const p = getActiveProfile();
  process.env.STASH_ADMIN_TOKEN = 'test-admin';
  const context = { params: Promise.resolve({ profileId: String(p.id) }) };
  assert.equal(
    (await download(new Request('http://localhost/download'), context)).status,
    401
  );
  const headers = { Authorization: 'Bearer test-admin' };
  assert.equal(
    (
      await download(
        new Request('http://localhost/download?url=private', { headers }),
        context
      )
    ).status,
    400
  );
  const good = await download(
    new Request('http://localhost/download', { headers }),
    context
  );
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.equal((await legacy()).status, 410);
});

test('secret-aware imports and history restoration retain isolated source bindings without DTO leaks', () => {
  const p = getActiveProfile();
  const snapshot = importYaml(
    p.id,
    `mode: rule\nproxy-providers:\n  private:\n    url: ${secretA}\n    headers: {Authorization: secret-header}\nrules: ["MATCH,DIRECT"]\n`
  );
  assert.equal(JSON.stringify(snapshot).includes(secretA), false);
  const revision = snapshot.profile.revision;
  const provider = snapshot.proxyProviders[0];
  updateProxyProvider(p.id, provider.id, {
    name: 'private',
    sourceUrl: secretB,
    config: {}
  });
  assert.equal(
    JSON.stringify(restoreRevision(p.id, revision)).includes(secretA),
    false
  );
  assert.equal(
    parse(getLatestConfig(p.id).yaml)['proxy-providers'].private.url,
    secretA
  );
  const placeholder = importYaml(
    p.id,
    'proxy-providers:\n  private:\n    url: https://example.invalid/replace\n    path: ./providers/private.yaml\nrules: ["MATCH,DIRECT"]'
  );
  assert.equal(placeholder.proxyProviders[0].sourceConfigured, true);
  assert.equal(
    parse(getLatestConfig(p.id).yaml)['proxy-providers'].private.url,
    secretA
  );
});

test('explicit secret clearing makes remote configuration invalid until repaired', () => {
  const p = getActiveProfile();
  const source = createProxyProvider(p.id, {
    name: 'subscription',
    sourceUrl: secretA,
    config: {}
  });
  updateProxyProvider(p.id, source.id, {
    name: source.name,
    clearSource: true,
    config: {}
  });
  assert.equal(getSnapshot(p.id).proxyProviders[0].sourceConfigured, false);
  assert.equal(getDeliveryStatus(p.id).current, false);
  assert.equal(
    parse(getLatestConfig(p.id).yaml)['proxy-providers'].subscription.url,
    secretA
  );
});

test('routing diagnostics find suffix and CIDR coverage; simulator never claims certainty past remote rules', () => {
  const p = getActiveProfile();
  createRule(p.id, {
    type: 'DOMAIN-SUFFIX',
    payload: 'example.test',
    policy: 'DIRECT'
  });
  const child = createRule(p.id, {
    type: 'DOMAIN',
    payload: 'api.example.test',
    policy: 'REJECT'
  });
  const snapshot = getSnapshot(p.id);
  assert.ok(
    validateSnapshot(snapshot).issues.some(
      (i) => i.resourceId === child.id && i.code === 'rule.covered'
    )
  );
  assert.equal(
    simulateRouting(snapshot, { host: 'api.example.test' }).candidate?.type,
    'DOMAIN-SUFFIX'
  );
  assert.equal(
    simulateRouting(snapshot, { host: 'api.example.test' }).conclusive,
    true
  );
  createRuleProvider(p.id, {
    name: 'any-name',
    behavior: 'domain',
    providerType: 'remote',
    config: { url: 'https://rules.test/list' },
    entries: []
  });
  createRule(p.id, {
    type: 'RULE-SET',
    payload: 'any-name',
    policy: 'REJECT',
    priority: 1
  });
  const uncertain = simulateRouting(getSnapshot(p.id), {
    host: 'api.example.test'
  });
  assert.equal(uncertain.conclusive, false);
  assert.equal(uncertain.uncertainRules.length, 1);
  assert.equal(cidrContains('10.0.0.0/8', '10.1.0.0/16'), true);
  assert.equal(cidrContains('10.1.0.0/16', '10.0.0.0/8'), false);
  assert.equal(cidrContains('2001:db8::/32', '2001:db8:1::1'), true);
  assert.equal(cidrContains('2001:db8::/32', '2001:abcd::1'), false);
});

test('platform-aware rules and direct-only configurations do not require demo groups or rule-mode semantics', () => {
  const p = getActiveProfile();
  createRule(p.id, {
    type: 'PROCESS-NAME',
    payload: 'SomeApp',
    policy: 'REJECT'
  });
  const original = getSnapshot(p.id).profile;
  saveSettings(p.id, { ...original, targetPlatform: 'macos' });
  assert.equal(
    validateSnapshot(getSnapshot(p.id)).issues.some(
      (i) => i.code === 'rule.process-ios'
    ),
    false
  );
  saveSettings(p.id, { ...original, targetPlatform: 'ios' });
  assert.equal(
    simulateRouting(getSnapshot(p.id), { process: 'SomeApp' }).candidate?.type,
    'MATCH'
  );
  assert.ok(
    validateSnapshot(getSnapshot(p.id)).issues.some(
      (i) => i.code === 'rule.process-ios'
    )
  );
  importYaml(p.id, 'mode: direct\nrules: []');
  assert.equal(getDeliveryStatus(p.id).current, true);
  assert.equal(simulateRouting(getSnapshot(p.id), {}).mode, 'direct');
  assert.equal(getCompilationSnapshot(p.id).profile.targetPlatform, 'ios');
  assert.equal(getDb().pragma('user_version', { simple: true }), 3);
});

test('supported HTTP and URL authentication sources are preserved while warnings stay redacted', () => {
  const p = getActiveProfile();
  const privateUrl =
    'http://user:example-' + 'credential@subscription.test/file';
  createProxyProvider(p.id, {
    name: 'local-subscription',
    sourceUrl: privateUrl,
    config: {}
  });
  assert.equal(JSON.stringify(getSnapshot(p.id)).includes('credential'), false);
  assert.ok(
    validateSnapshot(getCompilationSnapshot(p.id)).issues.some(
      (i) => i.code === 'proxy-provider.http-source'
    )
  );
  assert.equal(
    parse(getLatestConfig(p.id).yaml)['proxy-providers']['local-subscription']
      .url,
    privateUrl
  );
});

test('wildcard and inline matching are name independent and pre-matching remains explicitly uncertain', () => {
  const p = getActiveProfile();
  createRuleProvider(p.id, {
    name: 'custom',
    behavior: 'domain',
    providerType: 'inline',
    config: {},
    entries: ['+.arbitrary.test']
  });
  createRule(p.id, { type: 'RULE-SET', payload: 'custom', policy: 'REJECT' });
  assert.equal(
    simulateRouting(getSnapshot(p.id), { host: 'sub.arbitrary.test' }).candidate
      ?.policy,
    'REJECT'
  );
  createRule(p.id, {
    type: 'DOMAIN-WILDCARD',
    payload: '*.other.test',
    policy: 'REJECT'
  });
  assert.equal(
    simulateRouting(getSnapshot(p.id), { host: 'sub.other.test' }).candidate
      ?.type,
    'DOMAIN-WILDCARD'
  );
  createRule(p.id, {
    type: 'DOMAIN',
    payload: 'blocked.test',
    policy: 'REJECT',
    options: ['pre-matching']
  });
  assert.equal(
    simulateRouting(getSnapshot(p.id), { host: 'sub.other.test' }).conclusive,
    false
  );
});

test('a delayed compilation cannot replace a newer successful artifact', async () => {
  const { refreshCompiledConfig } = await import('../lib/compilation');
  const p = getActiveProfile();
  const old = getCompilationSnapshot(p.id);
  createRule(p.id, { type: 'DOMAIN', payload: 'new.test', policy: 'DIRECT' });
  const latest = getLatestConfig(p.id);
  refreshCompiledConfig(getDb(), old);
  assert.equal(getLatestConfig(p.id).revision, latest.revision);
});

test('API diagnostics inspect imported credentials without disclosing invalid source details', async () => {
  const { GET } = await import(
    '../app/api/profiles/[profileId]/snapshot/route'
  );
  const p = getActiveProfile();
  const invalid = 'file:///private-sensitive-location';
  importYaml(
    p.id,
    `proxy-providers:\n  source:\n    url: ${invalid}\nrules: ["MATCH,DIRECT"]`
  );
  const response = await GET(new Request('http://localhost/snapshot'), {
    params: Promise.resolve({ profileId: String(p.id) })
  });
  const data = await response.json();
  assert.equal(data.validation.valid, false);
  assert.equal(JSON.stringify(data).includes(invalid), false);
});

test('importing a file-only provider keeps it local without requiring a subscription URL', () => {
  const p = getActiveProfile();
  const snapshot = importYaml(
    p.id,
    'proxy-providers:\n  local-only:\n    path: ./providers/local.yaml\nrules: ["MATCH,DIRECT"]'
  );
  assert.equal(snapshot.proxyProviders[0].sourceType, 'local');
  assert.equal(snapshot.proxyProviders[0].sourceConfigured, true);
  assert.equal(getDeliveryStatus(p.id).current, true);
});

test('clearing an imported remote URL never silently turns its cache into a local source', () => {
  const p = getActiveProfile();
  const snapshot = importYaml(
    p.id,
    `proxy-providers:\n  remote:\n    url: ${secretA}\n    path: ./providers/cache.yaml\nrules: ["MATCH,DIRECT"]`
  );
  const source = snapshot.proxyProviders[0];
  updateProxyProvider(p.id, source.id, {
    name: source.name,
    clearSource: true,
    config: { path: './providers/cache.yaml' }
  });
  const changed = getSnapshot(p.id).proxyProviders[0];
  assert.equal(changed.sourceType, 'remote');
  assert.equal(changed.sourceConfigured, false);
  assert.equal(getDeliveryStatus(p.id).current, false);
});

test('download APIs return complete links and honor the configured external origin', async () => {
  const { GET } = await import(
    '../app/api/profiles/[profileId]/delivery/route'
  );
  const p = getActiveProfile();
  rotateDownloadLink(p.id);
  process.env.STASH_PUBLIC_BASE_URL = 'https://config.example';
  try {
    const response = await GET(new Request('http://internal/delivery'), {
      params: Promise.resolve({ profileId: String(p.id) })
    });
    const status = await response.json();
    assert.equal(
      status.configDownloadUrl,
      `https://config.example/api/profiles/${p.id}/config_download`
    );
    assert.ok(
      status.subscriptionUrl.startsWith(
        'https://config.example/api/config_download/'
      )
    );
  } finally {
    delete process.env.STASH_PUBLIC_BASE_URL;
  }
});

test('DNS rule-set references in keys support user names and prevent deleting a referenced set', async () => {
  const { deleteRuleProvider } = await import('../lib/repository');
  const p = getActiveProfile();
  const provider = createRuleProvider(p.id, {
    name: '我的集合',
    behavior: 'domain',
    providerType: 'inline',
    config: {},
    entries: ['+.example.test']
  });
  const profile = getSnapshot(p.id).profile;
  saveSettings(p.id, {
    ...profile,
    settings: {
      dns: { 'nameserver-policy': { 'rule-set:我的集合': ['1.1.1.1'] } }
    }
  });
  assert.equal(validateSnapshot(getSnapshot(p.id)).valid, true);
  assert.throws(() => deleteRuleProvider(p.id, provider.id), /referenced/);
  saveSettings(p.id, {
    ...profile,
    settings: {
      dns: { 'nameserver-policy': { 'rule-set:不存在': ['1.1.1.1'] } }
    }
  });
  assert.ok(
    validateSnapshot(getSnapshot(p.id)).issues.some(
      (i) => i.code === 'dns.ruleset-missing'
    )
  );
});

test('resource relationships come from parsed references and contain no copied connection credentials', async () => {
  const { buildResourceGraph, resourceKey } = await import(
    '../lib/resource-graph'
  );
  const p = getActiveProfile();
  const imported = importYaml(
    p.id,
    `proxies:\n  - name: custom-node\n    type: ss\n    server: example.test\n    port: 443\n    password: synthetic-secret\nproxy-providers:\n  custom-source:\n    url: ${secretA}\nproxy-groups:\n  - name: custom-policy\n    type: select\n    proxies: [custom-node, DIRECT]\n    use: [custom-source]\nrule-providers:\n  custom-set:\n    type: inline\n    behavior: domain\n    payload: ["+.example.test"]\nrules:\n  - RULE-SET,custom-set,custom-policy\n  - MATCH,DIRECT\n`
  );
  const graph = buildResourceGraph(imported);
  const group = imported.proxyGroups[0],
    source = imported.proxyProviders[0],
    node = imported.proxies[0],
    rule = imported.rules[0];
  assert.ok(
    graph.edges.some(
      (e) =>
        e.from === resourceKey('proxy-groups', group.id) &&
        e.to === resourceKey('proxy-providers', source.id)
    )
  );
  assert.ok(
    graph.edges.some(
      (e) =>
        e.from === resourceKey('proxy-groups', group.id) &&
        e.to === resourceKey('proxies', node.id)
    )
  );
  assert.ok(
    graph.edges.some(
      (e) =>
        e.from === resourceKey('rules', rule.id) &&
        e.to === resourceKey('proxy-groups', group.id)
    )
  );
  assert.ok(
    graph.edges.some(
      (e) =>
        e.from === resourceKey('rules', rule.id) &&
        e.to === resourceKey('rule-providers', imported.ruleProviders[0].id)
    )
  );
  assert.equal(JSON.stringify(graph).includes('synthetic-secret'), false);
});

test('extension field edits retain arbitrary nested types and expose actual script relationships', async () => {
  const { replaceAdvancedSections } = await import('../lib/repository');
  const { buildResourceGraph, resourceKey } = await import(
    '../lib/resource-graph'
  );
  const p = getActiveProfile();
  const sections: Array<{ key: string; value: JsonValue }> = [
    {
      key: 'custom-extension',
      value: {
        enabled: true,
        attempts: 3,
        nested: [{ name: 'item', values: [1, false, null] }]
      }
    },
    {
      key: 'script-providers',
      value: { 'my-script': { url: 'https://example.test/script.js' } }
    },
    {
      key: 'cron',
      value: { script: [{ name: 'my-script', cron: '0 2 * * *', timeout: 10 }] }
    }
  ];
  replaceAdvancedSections(p.id, sections);
  const config = parse(getLatestConfig(p.id).yaml);
  assert.deepEqual(config['custom-extension'], sections[0].value);
  const snapshot = getSnapshot(p.id),
    graph = buildResourceGraph(snapshot);
  const cron = snapshot.advancedSections.find((s) => s.key === 'cron')!,
    scripts = snapshot.advancedSections.find(
      (s) => s.key === 'script-providers'
    )!;
  assert.ok(
    graph.edges.some(
      (e) =>
        e.from === resourceKey('advanced', cron.id) &&
        e.to === resourceKey('advanced', scripts.id)
    )
  );
});
