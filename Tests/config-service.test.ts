import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, after, describe, test } from 'node:test';
import Database from 'better-sqlite3';

import { parse as parseYaml } from 'yaml';

import { closeDbForTests, getDb } from '../lib/db';
import { decryptJson, encryptJson, resetEncryptionCacheForTests } from '../lib/crypto';
import { exportProfile } from '../lib/exporter';
import {
  createHost,
  createProxy,
  createProxyGroup,
  createRule,
  createRuleProvider,
  createRuleProviderEntry,
  deleteProxy,
  deleteProxyGroup,
  deleteRule,
  deleteRuleProvider,
  deleteRuleProviderEntry,
  getActiveProfile,
  getSnapshot,
  importYaml,
  listRevisions,
  reorderRules,
  resetRepositoryForTests,
  restoreRevision,
  updateProxy,
  updateProxyGroup,
  updateRuleProviderEntry
} from '../lib/repository';
import { validateSnapshot } from '../lib/validation';

const SECRET_URL =
  'https://subscription.test.example/api?token=private-value';
const root = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'stash-forge-'));
let sequence = 0;

function currentDbPath(): string {
  return process.env.STASH_DB_PATH as string;
}

beforeEach(() => {
  closeDbForTests();
  resetRepositoryForTests();
  resetEncryptionCacheForTests();
  sequence += 1;
  process.env.STASH_TEMPLATE_DIR = root;
  process.env.STASH_DB_PATH = path.join(tempRoot, `rules-${sequence}.sqlite3`);
  process.env.STASH_KEY_PATH = path.join(tempRoot, `rules-${sequence}.key`);
  delete process.env.STASH_ADMIN_TOKEN;
  delete process.env.STASH_SECRET_KEY;
});

after(() => {
  closeDbForTests();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('seed and export', () => {
  test('seeds the complete Production profile into SQLite', () => {
    const profile = getActiveProfile();
    const snapshot = getSnapshot(profile.id);
    assert.equal(snapshot.proxyProviders.length, 1);
    assert.equal(snapshot.proxyProviders[0].name, 'GLaDOS');
    assert.equal(snapshot.proxyProviders[0].requiresUrl, true);
    assert.equal(snapshot.proxyGroups.length, 13);
    assert.equal(snapshot.ruleProviders.length, 21);
    assert.equal(
      snapshot.ruleProviders.filter((item) => item.providerType === 'inline')
        .length,
      17
    );
    assert.equal(snapshot.rules.length, 30);
    assert.equal(snapshot.rules.at(-1)?.type, 'MATCH');
    assert.deepEqual(
      snapshot.rules.map((rule) => rule.priority),
      Array.from({ length: 30 }, (_unused, index) => index + 1)
    );
    assert.equal(validateSnapshot(snapshot).valid, true);
  });

  test('exports a complete Stash configuration and keeps the private URL out of SQLite', () => {
    const profile = getActiveProfile();
    const result = exportProfile(getSnapshot(profile.id), {
      subscriptionUrl: SECRET_URL,
      template: 'production'
    });
    const parsed = parseYaml(result.yaml) as Record<string, unknown>;
    assert.equal(
      (parsed['proxy-providers'] as Record<string, Record<string, unknown>>)
        .GLaDOS.url,
      SECRET_URL
    );
    assert.equal((parsed.rules as unknown[]).length, 30);
    assert.equal(Object.keys(parsed['proxy-groups'] as object).length, 13);
    assert.equal(
      Object.keys(parsed['rule-providers'] as object).length,
      21
    );
    assert.equal(result.sha256.length, 64);
    const databaseBytes = readFileSync(currentDbPath());
    assert.equal(databaseBytes.includes(SECRET_URL), false);
    assert.equal(existsSync(`${currentDbPath()}-wal`), true);
  });

  test('no-ads export removes the ad rule provider and its rule only', () => {
    const profile = getActiveProfile();
    const result = exportProfile(getSnapshot(profile.id), {
      subscriptionUrl: SECRET_URL,
      template: 'no_ads'
    });
    const parsed = parseYaml(result.yaml) as Record<string, unknown>;
    assert.equal(
      'Repcz-Ads-AWAvenue' in
        (parsed['rule-providers'] as Record<string, unknown>),
      false
    );
    assert.equal(
      (parsed.rules as string[]).some((rule) =>
        rule.includes('Repcz-Ads-AWAvenue')
      ),
      false
    );
  });
});

describe('database and encrypted storage', () => {
  test('records the schema version and refuses to open a newer database', () => {
    const db = getDb();
    assert.equal(Number(db.pragma('user_version', { simple: true })), 1);
    closeDbForTests();

    const newerDb = new Database(currentDbPath());
    newerDb.pragma('user_version = 99');
    newerDb.close();

    assert.throws(() => getDb(), /newer than this service supports/);
    closeDbForTests();
  });

  test('compresses new encrypted JSON and still reads legacy v1 ciphertext', () => {
    const value = { rules: Array.from({ length: 500 }, () => 'DOMAIN-SUFFIX,example.test,Proxy') };
    const token = encryptJson(value);
    assert.equal(token.startsWith('v2.'), true);
    assert.ok(
      Buffer.from(token.split('.')[3], 'base64url').length <
        Buffer.byteLength(JSON.stringify(value))
    );
    assert.deepEqual(decryptJson(token), value);

    const key = randomBytes(32);
    process.env.STASH_SECRET_KEY = key.toString('hex');
    resetEncryptionCacheForTests();
    const nonce = randomBytes(12);
    const legacyCipher = createCipheriv('aes-256-gcm', key, nonce);
    const legacyPlaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([
      legacyCipher.update(legacyPlaintext),
      legacyCipher.final()
    ]);
    const legacyToken = [
      'v1',
      nonce.toString('base64url'),
      legacyCipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url')
    ].join('.');
    assert.deepEqual(decryptJson(legacyToken), value);
  });
});

describe('configuration CRUD', () => {
  test('rule CRUD and priority ordering affect export', () => {
    const profile = getActiveProfile();
    const created = createRule(profile.id, {
      type: 'DOMAIN',
      payload: 'created.example.test',
      policy: 'DIRECT',
      priority: 1
    });
    assert.equal(created.priority, 1);
    let snapshot = getSnapshot(profile.id);
    assert.equal(snapshot.rules[0].payload, 'created.example.test');
    assert.equal(snapshot.rules.at(-1)?.type, 'MATCH');

    const ids = snapshot.rules.map((rule) => rule.id);
    ids.splice(ids.indexOf(created.id), 1);
    ids.splice(1, 0, created.id);
    const reordered = reorderRules(profile.id, ids);
    assert.equal(reordered[1].id, created.id);
    assert.equal(reordered.at(-1)?.type, 'MATCH');

    assert.throws(
      () => deleteRule(profile.id, reordered.at(-1)!.id),
      /MATCH/
    );
    deleteRule(profile.id, created.id);
    snapshot = getSnapshot(profile.id);
    assert.equal(snapshot.rules.length, 30);
    assert.deepEqual(
      snapshot.rules.map((rule) => rule.priority),
      Array.from({ length: 30 }, (_unused, index) => index + 1)
    );
  });

  test('strategy-group rename cascades to rules and deletion protects references', () => {
    const profile = getActiveProfile();
    const snapshot = getSnapshot(profile.id);
    const source = snapshot.proxyGroups.find(
      (group) => group.name === '🤖 AI 服務'
    );
    const parent = snapshot.proxyGroups.find(
      (group) => group.name === '🌐 通用代理'
    );
    assert.ok(source);
    assert.ok(parent);
    const node = createProxy(profile.id, {
      name: 'ssid-node',
      type: 'ss',
      config: {}
    });
    updateProxyGroup(profile.id, parent.id, {
      name: parent.name,
      type: parent.type,
      config: {
        ...parent.config,
        'ssid-policy': {
          office: source.name,
          lab: node.name,
          default: 'DIRECT'
        }
      }
    });
    assert.throws(
      () => deleteProxy(profile.id, node.id),
      /SSID policy “lab” targets “ssid-node”/
    );
    assert.throws(
      () => deleteProxyGroup(profile.id, source.id),
      /SSID policy “office” targets “🤖 AI 服務”/
    );
    updateProxyGroup(profile.id, source.id, {
      name: 'AI-RENAMED',
      type: source.type,
      config: source.config
    });
    updateProxy(profile.id, node.id, {
      name: 'ssid-node-renamed',
      type: node.type,
      config: node.config
    });
    const renamedSnapshot = getSnapshot(profile.id);
    assert.equal(
      renamedSnapshot.rules.some((rule) => rule.policy === 'AI-RENAMED'),
      true
    );
    assert.equal(
      renamedSnapshot.rules.some((rule) => rule.policy === '🤖 AI 服務'),
      false
    );
    assert.deepEqual(
      renamedSnapshot.proxyGroups.find((group) => group.id === parent.id)?.config[
        'ssid-policy'
      ],
      {
        office: 'AI-RENAMED',
        lab: 'ssid-node-renamed',
        default: 'DIRECT'
      }
    );
    assert.equal(validateSnapshot(renamedSnapshot).valid, true);
  });

  test('rule-provider entries are independently editable', () => {
    const profile = getActiveProfile();
    const provider = getSnapshot(profile.id).ruleProviders.find(
      (item) => item.providerType === 'inline'
    );
    assert.ok(provider);
    const created = createRuleProviderEntry(profile.id, provider.id, {
      value: '+.entry.example.test',
      position: 1
    });
    assert.equal(created.sortOrder, 1);
    const updated = updateRuleProviderEntry(
      profile.id,
      provider.id,
      created.id,
      { value: '+.updated.example.test', position: 2 }
    );
    assert.equal(updated.value, '+.updated.example.test');
    assert.equal(updated.sortOrder, 2);
    deleteRuleProviderEntry(profile.id, provider.id, created.id);
  });

  test('referenced rule providers cannot be deleted', () => {
    const profile = getActiveProfile();
    const provider = getSnapshot(profile.id).ruleProviders.find((item) =>
      item.name.startsWith('hj-99-safety-domain')
    );
    assert.ok(provider);
    assert.throws(() => deleteRuleProvider(profile.id, provider.id), /referenced/);
  });

  test('host and directly declared proxy resources persist', () => {
    const profile = getActiveProfile();
    const host = createHost(profile.id, {
      pattern: 'router.lan',
      value: '192.168.1.1'
    });
    assert.equal(host.value, '192.168.1.1');
    const proxy = createProxy(profile.id, {
      name: 'local-test',
      type: 'socks5',
      config: {
        server: '127.0.0.1',
        port: 1080,
        password: 'must-not-be-plaintext'
      }
    });
    assert.equal(proxy.name, 'local-test');
    const bytes = readFileSync(currentDbPath()).toString('utf8');
    assert.equal(bytes.includes('must-not-be-plaintext'), false);
  });
});

describe('validation, history and import', () => {
  test('validation blocks missing rule policy targets', () => {
    const profile = getActiveProfile();
    createRule(profile.id, {
      type: 'DOMAIN',
      payload: 'broken.example.test',
      policy: 'MISSING-PROXY'
    });
    const result = validateSnapshot(getSnapshot(profile.id));
    assert.equal(result.valid, false);
    assert.equal(
      result.issues.some((issue) => issue.code === 'rule.policy-missing'),
      true
    );
  });

  test('revisions can restore a previous configuration', () => {
    const profile = getActiveProfile();
    const before = profile.revision;
    createRule(profile.id, {
      type: 'DOMAIN',
      payload: 'revision.example.test',
      policy: 'DIRECT'
    });
    assert.equal(getSnapshot(profile.id).rules.length, 31);
    assert.equal(listRevisions(profile.id).items.length > 0, true);
    restoreRevision(profile.id, before);
    assert.equal(getSnapshot(profile.id).rules.length, 30);
  });

  test('revision history pages newest-first without gaps or duplicates', () => {
    const profile = getActiveProfile();
    for (let index = 0; index < 4; index += 1) {
      createRule(profile.id, {
        type: 'DOMAIN',
        payload: `history-${index}.example.test`,
        policy: 'DIRECT'
      });
    }

    const first = listRevisions(profile.id, { limit: 2 });
    assert.equal(first.items.length, 2);
    assert.notEqual(first.nextCursor, null);
    assert.ok(first.items[0].revision > first.items[1].revision);

    const second = listRevisions(profile.id, {
      limit: 2,
      before: first.nextCursor!
    });
    assert.equal(second.items.length, 2);
    assert.notEqual(second.nextCursor, null);
    assert.ok(first.items.at(-1)!.revision > second.items[0].revision);

    const final = listRevisions(profile.id, {
      limit: 2,
      before: second.nextCursor!
    });
    assert.equal(final.items.length, 1);
    assert.equal(final.nextCursor, null);
  });

  test('full YAML import replaces the normalized profile', () => {
    const profile = getActiveProfile();
    const yaml = `
mode: rule
log-level: warning
dns:
  nameserver:
    - 1.1.1.1
proxy-groups:
  - name: Proxy
    type: select
    proxies:
      - DIRECT
rules:
  - MATCH,Proxy
`;
    const snapshot = importYaml(profile.id, yaml);
    assert.equal(snapshot.profile.mode, 'rule');
    assert.equal(snapshot.profile.logLevel, 'warning');
    assert.equal(snapshot.proxyGroups.length, 1);
    assert.equal(snapshot.rules.length, 1);
    assert.equal(validateSnapshot(snapshot).valid, true);
  });

  test('new inline rule providers and rules can be created', () => {
    const profile = getActiveProfile();
    const provider = createRuleProvider(profile.id, {
      name: 'custom-domain',
      behavior: 'domain',
      providerType: 'inline',
      config: {},
      entries: ['+.example.test']
    });
    assert.equal(provider.entries.length, 1);
    createRule(profile.id, {
      type: 'RULE-SET',
      payload: 'custom-domain',
      policy: 'DIRECT'
    });
    assert.equal(validateSnapshot(getSnapshot(profile.id)).valid, true);
    const rule = getSnapshot(profile.id).rules.find(
      (item) => item.type === 'RULE-SET' && item.payload === 'custom-domain'
    );
    assert.ok(rule);
    deleteRule(profile.id, rule.id);
    deleteRuleProvider(profile.id, provider.id);
  });

  test('new strategy groups can be CRUD-managed', () => {
    const profile = getActiveProfile();
    const group = createProxyGroup(profile.id, {
      name: 'NEW-GROUP',
      type: 'select',
      config: { proxies: ['DIRECT'] }
    });
    assert.equal(group.name, 'NEW-GROUP');
    deleteProxyGroup(profile.id, group.id);
    assert.equal(
      getSnapshot(profile.id).proxyGroups.some(
        (item) => item.name === 'NEW-GROUP'
      ),
      false
    );
  });
});
