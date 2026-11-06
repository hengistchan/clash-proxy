import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import { closeDbForTests, getDb } from '../lib/db';
import { resetEncryptionCacheForTests } from '../lib/crypto';
import { configForToken, getDeliveryStatus, getLatestConfig, rotateDownloadLink } from '../lib/delivery';
import { validateSnapshot } from '../lib/validation';
import {
  createProxy,
  createProxyGroup,
  createRule,
  deleteRule,
  getActiveProfile,
  getSnapshot,
  importYaml,
  reorderRules,
  resetRepositoryForTests,
  updateProxy,
  updateProxyGroup,
  updateRule
} from '../lib/repository';

const temp = mkdtempSync(path.join(os.tmpdir(), 'forge-invariants-'));
let sequence = 0;
beforeEach(() => {
  closeDbForTests();
  resetRepositoryForTests();
  resetEncryptionCacheForTests();
  process.env.STASH_DB_PATH = path.join(temp, `${++sequence}.sqlite3`);
  process.env.STASH_KEY_PATH = path.join(temp, `${sequence}.key`);
  delete process.env.STASH_SEED_EXAMPLE;
  delete process.env.STASH_SECRET_KEY;
});
after(() => {
  closeDbForTests();
  rmSync(temp, { recursive: true, force: true });
});

test('renaming rejects cross-table name collisions even when both resources share an ID', () => {
  const profile = getActiveProfile();
  const node = createProxy(profile.id, { name: 'node', type: 'ss', config: {} });
  const group = createProxyGroup(profile.id, { name: 'group', type: 'select', config: { proxies: ['node'] } });
  assert.equal(node.id, group.id);
  const before = getSnapshot(profile.id);
  assert.throws(() => updateProxy(profile.id, node.id, { name: 'group', type: 'ss', config: {} }), /unique policy names/);
  assert.throws(() => updateProxyGroup(profile.id, group.id, { name: 'node', type: 'select', config: {} }), /unique policy names/);
  assert.deepEqual(getSnapshot(profile.id), before);
  const renamed = updateProxy(profile.id, node.id, { name: 'renamed-node', type: 'ss', config: {} });
  assert.equal(renamed.name, 'renamed-node');
  assert.deepEqual(getSnapshot(profile.id).proxyGroups[0].config.proxies, ['renamed-node']);
});

for (const mode of ['direct', 'global']) {
  test(`${mode} profiles without MATCH support rule creation, editing, reordering and deletion`, () => {
    const profile = getActiveProfile();
    importYaml(profile.id, `mode: ${mode}\nrules: []`);
    const first = createRule(profile.id, { type: 'DOMAIN', payload: 'first.test', policy: 'DIRECT' });
    const second = createRule(profile.id, { type: 'DOMAIN', payload: 'second.test', policy: 'REJECT' });
    updateRule(profile.id, first.id, { type: 'DOMAIN', payload: 'edited.test', policy: 'DIRECT', priority: 2 });
    assert.deepEqual(getSnapshot(profile.id).rules.map((rule) => rule.id), [second.id, first.id]);
    reorderRules(profile.id, [first.id, second.id]);
    assert.deepEqual(parse(getLatestConfig(profile.id).yaml).rules, ['DOMAIN,edited.test,DIRECT', 'DOMAIN,second.test,REJECT']);
    deleteRule(profile.id, first.id);
    deleteRule(profile.id, second.id);
    assert.deepEqual(parse(getLatestConfig(profile.id).yaml).rules, []);
  });
}

test('a non-rule profile can add or convert its first terminal MATCH and keeps it last', () => {
  const profile = getActiveProfile();
  importYaml(profile.id, 'mode: direct\nrules: []');
  const rule = createRule(profile.id, { type: 'DOMAIN', payload: 'app.test', policy: 'DIRECT' });
  const another = createRule(profile.id, { type: 'DOMAIN', payload: 'other.test', policy: 'DIRECT' });
  updateRule(profile.id, rule.id, { type: 'MATCH', policy: 'DIRECT', priority: 1 });
  assert.deepEqual(getSnapshot(profile.id).rules.map((item) => item.id), [another.id, rule.id]);
  importYaml(profile.id, 'mode: global\nrules: []');
  const terminal = createRule(profile.id, { type: 'MATCH', policy: 'DIRECT' });
  const next = createRule(profile.id, { type: 'DOMAIN', payload: 'app.test', policy: 'DIRECT' });
  assert.deepEqual(getSnapshot(profile.id).rules.map((item) => item.id), [next.id, terminal.id]);
});

test('rule mode retains terminal MATCH protections after optional MATCH support', () => {
  const profile = getActiveProfile();
  const terminal = getSnapshot(profile.id).rules[0];
  const rule = createRule(profile.id, { type: 'DOMAIN', payload: 'app.test', policy: 'DIRECT' });
  assert.throws(() => createRule(profile.id, { type: 'MATCH', policy: 'DIRECT' }), /already exists/);
  assert.throws(() => updateRule(profile.id, terminal.id, { type: 'DOMAIN', payload: 'bad.test', policy: 'DIRECT' }), /cannot be converted/);
  assert.throws(() => updateRule(profile.id, terminal.id, { type: 'MATCH', policy: 'DIRECT', enabled: false }), /cannot be converted or disabled/);
  assert.throws(() => updateRule(profile.id, rule.id, { type: 'MATCH', policy: 'DIRECT' }), /already exists/);
  assert.throws(() => reorderRules(profile.id, [terminal.id, rule.id]), /end with MATCH/);
  assert.throws(() => deleteRule(profile.id, terminal.id), /cannot be deleted/);
  assert.deepEqual(parse(getLatestConfig(profile.id).yaml).rules, ['DOMAIN,app.test,DIRECT', 'MATCH,DIRECT']);
});

test('rule-mode drafts with missing MATCH can be repaired by adding or converting the terminal rule', () => {
  const profile = getActiveProfile();
  const token = rotateDownloadLink(profile.id).subscriptionPath!.split('/')[3];
  const lastGood = getLatestConfig(profile.id);
  importYaml(profile.id, 'mode: rule\nrules: []');
  assert.equal(getDeliveryStatus(profile.id).current, false);
  assert.equal(configForToken(token).revision, lastGood.revision);
  assert.throws(() => createRule(profile.id, { type: 'MATCH', policy: 'DIRECT', enabled: false }), /must remain enabled/);
  createRule(profile.id, { type: 'MATCH', policy: 'REJECT' });
  assert.equal(getDeliveryStatus(profile.id).current, true);
  assert.deepEqual(parse(configForToken(token).yaml).rules, ['MATCH,REJECT']);

  const imported = importYaml(profile.id, 'mode: rule\nrules: ["DOMAIN,first.test,DIRECT", "DOMAIN,second.test,REJECT"]');
  const first = imported.rules[0];
  updateRule(profile.id, first.id, { type: 'MATCH', policy: 'DIRECT', priority: 1 });
  assert.equal(getDeliveryStatus(profile.id).current, true);
  assert.deepEqual(parse(configForToken(token).yaml).rules, ['DOMAIN,second.test,REJECT', 'MATCH,DIRECT']);
});

test('saving a misplaced or disabled MATCH repairs the draft without weakening terminal protections', () => {
  const profile = getActiveProfile();
  const misplaced = importYaml(profile.id, 'rules: ["MATCH,DIRECT", "DOMAIN,app.test,REJECT"]');
  assert.equal(validateSnapshot(misplaced).valid, false);
  updateRule(profile.id, misplaced.rules[0].id, { type: 'MATCH', policy: 'DIRECT', enabled: true, priority: 1 });
  assert.deepEqual(parse(getLatestConfig(profile.id).yaml).rules, ['DOMAIN,app.test,REJECT', 'MATCH,DIRECT']);

  // Disabled MATCH snapshots may come from older service versions.
  const terminal = getSnapshot(profile.id).rules.at(-1)!;
  getDb().prepare('UPDATE rules SET enabled = 0 WHERE id = ?').run(terminal.id);
  assert.equal(validateSnapshot(getSnapshot(profile.id)).valid, false);
  updateRule(profile.id, terminal.id, { type: 'MATCH', policy: 'DIRECT', enabled: true });
  assert.equal(validateSnapshot(getSnapshot(profile.id)).valid, true);
  assert.throws(() => deleteRule(profile.id, terminal.id), /cannot be deleted/);
  assert.throws(() => updateRule(profile.id, terminal.id, { type: 'MATCH', policy: 'DIRECT', enabled: false }), /cannot be converted or disabled/);
});

test('duplicate MATCH drafts allow deleting extras while protecting the final enabled terminal', () => {
  const profile = getActiveProfile();
  const lastGood = getLatestConfig(profile.id);
  const duplicates = importYaml(profile.id, 'rules: ["MATCH,REJECT", "DOMAIN,app.test,DIRECT", "MATCH,DIRECT"]');
  assert.equal(getLatestConfig(profile.id).revision, lastGood.revision);
  const finalMatch = duplicates.rules.at(-1)!;
  assert.throws(() => deleteRule(profile.id, finalMatch.id), /cannot be deleted/);
  deleteRule(profile.id, duplicates.rules[0].id);
  assert.equal(validateSnapshot(getSnapshot(profile.id)).valid, true);
  assert.deepEqual(parse(getLatestConfig(profile.id).yaml).rules, ['DOMAIN,app.test,DIRECT', 'MATCH,DIRECT']);
  assert.throws(() => deleteRule(profile.id, finalMatch.id), /cannot be deleted/);
});
