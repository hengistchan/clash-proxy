import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareConfigurations } from '../lib/config-diff';
import { compareRevision, previewImport } from '../lib/revision-comparison';
import { closeDbForTests, getDb } from '../lib/db';
import { resetEncryptionCacheForTests } from '../lib/crypto';
import { configForToken, getLatestConfig, rotateDownloadLink } from '../lib/delivery';
import { createHost, getActiveProfile, getCompilationSnapshot, getSnapshot, listRevisions, resetRepositoryForTests } from '../lib/repository';
import { pruneRevisionHistory } from '../lib/history-retention';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'forge-diff-'));
let sequence = 0;
beforeEach(() => {
  closeDbForTests(); resetRepositoryForTests(); resetEncryptionCacheForTests();
  process.env.STASH_DB_PATH = path.join(temporary, `${++sequence}.sqlite3`);
  process.env.STASH_KEY_PATH = path.join(temporary, `${sequence}.key`);
  delete process.env.STASH_SECRET_KEY; delete process.env.STASH_SEED_EXAMPLE; delete process.env.STASH_REVISION_LIMIT;
});
after(() => { closeDbForTests(); rmSync(temporary, { recursive: true, force: true }); });

test('semantic comparisons ignore storage IDs, metadata and object key ordering', () => {
  const before = getCompilationSnapshot(getActiveProfile().id);
  before.profile.settings = { dns: { enabled: true, nameserver: ['1.1.1.1'] } };
  const after = structuredClone(before);
  after.profile.revision += 1; after.profile.updatedAt = '2099-01-01';
  after.rules[0].id += 99;
  after.profile.settings = { dns: { nameserver: ['1.1.1.1'], enabled: true } };
  const diff = compareConfigurations(before, after);
  assert.equal(diff.totalChanges, 0);
  assert.deepEqual(diff.orderChanged, []);
});

test('semantic differences distinguish additions, removals, parameter changes and routing order', () => {
  const before = getCompilationSnapshot(getActiveProfile().id);
  before.rules.unshift({ id: 2, priority: 1, type: 'DOMAIN', payload: 'a.test', policy: 'DIRECT', options: [], enabled: true, note: '' }, { id: 3, priority: 2, type: 'DOMAIN', payload: 'b.test', policy: 'DIRECT', options: [], enabled: true, note: '' });
  before.hosts = [{ id: 1, pattern: 'old.test', value: '192.0.2.1', sortOrder: 1 }];
  const after = structuredClone(before);
  after.rules = [after.rules[1], after.rules[0], after.rules[2]];
  after.rules[0].policy = 'REJECT';
  after.hosts = [{ id: 99, pattern: 'new.test', value: '192.0.2.2', sortOrder: 1 }];
  const diff = compareConfigurations(before, after);
  assert.equal(diff.added, 1); assert.equal(diff.removed, 1); assert.equal(diff.changed, 1);
  assert.deepEqual(diff.orderChanged, ['路由规则']);
  assert.deepEqual(diff.changes.find((item) => item.resource === '路由规则')?.fields, ['目标策略']);
});

test('diff summaries expose neither credentials, field values nor URLs disguised as resource names', () => {
  const before = getCompilationSnapshot(getActiveProfile().id);
  const after = structuredClone(before);
  const secret = 'https://private.test/sub?token=private-value';
  before.proxies = [{ id: 1, name: 'node', type: 'ss', config: { password: 'old-password' }, sortOrder: 1 }];
  after.proxies = [{ ...before.proxies[0], config: { password: 'new-password', headers: { Authorization: 'Bearer very-private' } } }];
  after.proxyProviders = [{ id: 1, name: secret, config: { url: secret }, requiresUrl: false, sourceType: 'remote', sourceConfigured: true, headersConfigured: false, sortOrder: 1 }];
  after.advancedSections = [{ id: 1, key: 'private-extension', value: { secret, 'another-token': 'unshown' }, sortOrder: 1 }];
  const diff = compareConfigurations(before, after);
  const text = JSON.stringify(diff);
  for (const value of [secret, 'private-value', 'old-password', 'new-password', 'very-private', 'unshown', 'another-token']) assert.equal(text.includes(value), false);
  assert.equal(diff.changes.some((item) => item.label.includes('已隐藏')), true);
});

test('large semantic summaries remain bounded while preserving complete counts', () => {
  const before = getCompilationSnapshot(getActiveProfile().id), after = structuredClone(before);
  after.hosts = Array.from({ length: 600 }, (_, index) => ({ id: index + 1, pattern: `host-${index}.test`, value: '192.0.2.1', sortOrder: index }));
  const diff = compareConfigurations(before, after);
  assert.equal(diff.added, 600); assert.equal(diff.totalChanges, 600); assert.equal(diff.changes.length, 500); assert.equal(diff.truncated, true);
});

test('import preview reuses import semantics without changing resources, history, retained anchors or device output', () => {
  const profile = getActiveProfile();
  process.env.STASH_REVISION_LIMIT = '10';
  for (let index = 0; index < 14; index++) createHost(profile.id, { pattern: `host-${index}.test`, value: '192.0.2.1' });
  pruneRevisionHistory(getDb(), profile.id);
  const before = getSnapshot(profile.id), history = listRevisions(profile.id), artifact = getLatestConfig(profile.id);
  const token = rotateDownloadLink(profile.id).subscriptionPath!.split('/')[3];
  const preview = previewImport(profile.id, 'hosts: { replacement.test: 192.0.2.2 }\nrules: ["MATCH,DIRECT"]');
  assert.equal(preview.currentRevision, before.profile.revision);
  assert.equal(preview.changes.added, 1);
  assert.equal(preview.changes.removed, 14);
  assert.match(preview.normalizationNotice, /注释/);
  assert.deepEqual(getSnapshot(profile.id), before); assert.deepEqual(listRevisions(profile.id), history);
  assert.deepEqual(getLatestConfig(profile.id), artifact); assert.equal(configForToken(token).yaml, artifact.yaml);
  assert.throws(() => previewImport(profile.id, 'rules: invalid'), /rules/);
  assert.deepEqual(getSnapshot(profile.id), before); assert.deepEqual(listRevisions(profile.id), history);
});

test('history comparison is read-only and detects semantic differences from the selected current revision', () => {
  const profile = getActiveProfile(), first = getSnapshot(profile.id);
  createHost(profile.id, { pattern: 'later.test', value: '192.0.2.1' });
  const before = getSnapshot(profile.id), history = listRevisions(profile.id);
  const preview = compareRevision(profile.id, first.profile.revision);
  assert.equal(preview.currentRevision, before.profile.revision); assert.equal(preview.targetRevision, first.profile.revision);
  assert.equal(preview.changes.removed, 1);
  assert.deepEqual(getSnapshot(profile.id), before); assert.deepEqual(listRevisions(profile.id), history);
  assert.throws(() => compareRevision(profile.id, 99999), /not found/);
});
