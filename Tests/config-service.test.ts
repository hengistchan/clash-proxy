import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, after, describe, test } from 'node:test';
import Database from 'better-sqlite3';

import { parse as parseYaml } from 'yaml';

import { closeDbForTests, getDb } from '../lib/db';
import {
  decryptJson,
  encryptJson,
  resetEncryptionCacheForTests
} from '../lib/crypto';
import { exportProfile } from '../lib/exporter';
import { getCompilationSnapshot } from '../lib/repository';
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
  updateRuleProvider,
  updateRuleProviderEntry
} from '../lib/repository';
import { validateSnapshot } from '../lib/validation';

const SECRET_URL = 'https://subscription.test.example/api?token=private-value';
const root = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'stash-forge-'));
const fixtureDir = path.join(tempRoot, 'templates');
mkdirSync(fixtureDir);
writeFileSync(
  path.join(fixtureDir, 'Production.yaml'),
  readFileSync(path.join(root, 'examples', 'Production.yaml'), 'utf8').replace(
    'https://example.invalid/REPLACE_WITH_PRIVATE_SUBSCRIPTION_URL',
    SECRET_URL
  )
);
let sequence = 0;

function currentDbPath(): string {
  return process.env.STASH_DB_PATH as string;
}

beforeEach(() => {
  closeDbForTests();
  resetRepositoryForTests();
  resetEncryptionCacheForTests();
  sequence += 1;
  process.env.STASH_TEMPLATE_DIR = fixtureDir;
  process.env.STASH_SEED_EXAMPLE = '1';
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
    assert.equal(snapshot.proxyProviders[0].name, 'example-subscription');
    assert.equal(snapshot.proxyProviders[0].requiresUrl, false);
    assert.equal(snapshot.proxies.length, 1);
    assert.equal(snapshot.proxyGroups.length, 2);
    assert.equal(snapshot.ruleProviders.length, 1);
    assert.equal(
      snapshot.ruleProviders.filter((item) => item.providerType === 'inline')
        .length,
      1
    );
    assert.equal(snapshot.rules.length, 3);
    assert.equal(snapshot.rules.at(-1)?.type, 'MATCH');
    assert.deepEqual(
      snapshot.rules.map((rule) => rule.priority),
      [1, 2, 3]
    );
    assert.equal(validateSnapshot(snapshot).valid, true);
  });

  test('exports a complete Stash configuration and keeps the private URL out of SQLite', () => {
    const profile = getActiveProfile();
    const result = exportProfile(getCompilationSnapshot(profile.id));
    const parsed = parseYaml(result.yaml) as Record<string, unknown>;
    assert.equal(
      (parsed['proxy-providers'] as Record<string, Record<string, unknown>>)
        ['example-subscription'].url,
      SECRET_URL
    );
    assert.equal((parsed.rules as unknown[]).length, 3);
    assert.equal(Object.keys(parsed['proxy-groups'] as object).length, 2);
    assert.equal(Object.keys(parsed['rule-providers'] as object).length, 1);
    assert.equal(result.sha256.length, 64);
    const databaseBytes = readFileSync(currentDbPath());
    assert.equal(databaseBytes.includes(SECRET_URL), false);
    assert.equal(existsSync(`${currentDbPath()}-wal`), true);
  });

  test('export preserves imported providers without name-based filtering', () => {
    const profile = getActiveProfile();
    const result = exportProfile(getCompilationSnapshot(profile.id));
    const parsed = parseYaml(result.yaml) as Record<string, unknown>;
    assert.equal(
      'example-domains' in
        (parsed['rule-providers'] as Record<string, unknown>),
      true
    );
    assert.equal(
      (parsed.rules as string[]).some((rule) =>
        rule.includes('example-domains')
      ),
      true
    );
  });
});

describe('database and encrypted storage', () => {
  test('records the schema version and refuses to open a newer database', () => {
    const db = getDb();
    assert.equal(Number(db.pragma('user_version', { simple: true })), 3);
    assert.ok(
      db
        .prepare('PRAGMA table_info(rule_providers)')
        .all()
        .some((column) => (column as { name: string }).name === 'display_name')
    );
    closeDbForTests();

    const newerDb = new Database(currentDbPath());
    newerDb.pragma('user_version = 99');
    newerDb.close();

    assert.throws(() => getDb(), /newer than this service supports/);
    closeDbForTests();
  });

  test('migrates an existing version 1 database with an empty display name', () => {
    closeDbForTests();
    const legacyPath = path.join(tempRoot, `legacy-${sequence}.sqlite3`);
    const legacyDb = new Database(legacyPath);
    legacyDb.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY);
      CREATE TABLE rule_providers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        behavior TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        config_ciphertext TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    legacyDb.close();

    const previousPath = process.env.STASH_DB_PATH;
    process.env.STASH_DB_PATH = legacyPath;
    const migrated = getDb();
    assert.equal(Number(migrated.pragma('user_version', { simple: true })), 3);
    assert.equal(
      (
        migrated.prepare('PRAGMA table_info(rule_providers)').all() as Array<{
          name: string;
        }>
      ).some((column) => column.name === 'display_name'),
      true
    );
    closeDbForTests();
    process.env.STASH_DB_PATH = previousPath;
  });

  test('compresses new encrypted JSON and still reads legacy v1 ciphertext', () => {
    const value = {
      rules: Array.from(
        { length: 500 },
        () => 'DOMAIN-SUFFIX,example.test,Proxy'
      )
    };
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

    assert.throws(() => deleteRule(profile.id, reordered.at(-1)!.id), /MATCH/);
    deleteRule(profile.id, created.id);
    snapshot = getSnapshot(profile.id);
    assert.equal(snapshot.rules.length, 3);
    assert.deepEqual(
      snapshot.rules.map((rule) => rule.priority),
      [1, 2, 3]
    );
  });

  test('strategy-group rename cascades to rules and deletion protects references', () => {
    const profile = getActiveProfile();
    const snapshot = getSnapshot(profile.id);
    const source = snapshot.proxyGroups.find(
      (group) => group.name === 'Regional'
    );
    const parent = snapshot.proxyGroups.find((group) => group.name === 'Proxy');
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
      /referenced/
    );
    updateProxyGroup(profile.id, source.id, {
      name: 'Regional-Renamed',
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
      renamedSnapshot.rules.some((rule) => rule.policy === 'Regional-Renamed'),
      true
    );
    assert.equal(
      renamedSnapshot.rules.some((rule) => rule.policy === 'Regional'),
      false
    );
    assert.deepEqual(
      renamedSnapshot.proxyGroups.find((group) => group.id === parent.id)
        ?.config['ssid-policy'],
      {
        office: 'Regional-Renamed',
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

  test('rule-provider display names persist in SQLite but never change Stash identifiers', () => {
    const profile = getActiveProfile();
    const provider = getSnapshot(profile.id).ruleProviders.find(
      (item) => item.name === 'example-domains'
    );
    assert.ok(provider);
    const updated = updateRuleProvider(profile.id, provider.id, {
      name: provider.name,
      displayName: '示例域名',
      behavior: provider.behavior,
      providerType: provider.providerType,
      config: provider.config,
      entries: provider.entries.map((entry) => entry.value)
    });
    assert.equal(updated.displayName, '示例域名');

    const reimported = importYaml(
      profile.id,
      readFileSync(path.join(root, 'examples', 'Production.yaml'), 'utf8')
    );
    assert.equal(
      reimported.ruleProviders.find((item) => item.name === provider.name)
        ?.displayName,
      '示例域名'
    );

    const exported = exportProfile(getCompilationSnapshot(profile.id));
    const parsed = parseYaml(exported.yaml) as Record<string, unknown>;
    const exportedProviders = parsed['rule-providers'] as Record<
      string,
      Record<string, unknown>
    >;
    assert.ok(exportedProviders[provider.name]);
    assert.equal('示例域名' in exportedProviders, false);
    assert.equal('displayName' in exportedProviders[provider.name], false);
  });

  test('referenced rule providers cannot be deleted', () => {
    const profile = getActiveProfile();
    const provider = getSnapshot(profile.id).ruleProviders.find(
      (item) => item.name === 'example-domains'
    );
    assert.ok(provider);
    assert.throws(
      () => deleteRuleProvider(profile.id, provider.id),
      /referenced/
    );
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
    assert.equal(getSnapshot(profile.id).rules.length, 4);
    assert.equal(listRevisions(profile.id).items.length > 0, true);
    restoreRevision(profile.id, before);
    assert.equal(getSnapshot(profile.id).rules.length, 3);
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
