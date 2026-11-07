import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDbForTests } from '../lib/db';
import { resetEncryptionCacheForTests } from '../lib/crypto';
import { createHost, getActiveProfile, getSnapshot, listRevisions, resetRepositoryForTests, createProfile, createRule } from '../lib/repository';
import { getLatestConfig } from '../lib/delivery';
import { GET as snapshotGet } from '../app/api/profiles/[profileId]/snapshot/route';
import { POST as resourcePost } from '../app/api/profiles/[profileId]/[resource]/route';
import { PUT as resourcePut, DELETE as resourceDelete } from '../app/api/profiles/[profileId]/[resource]/[itemId]/route';
import { PUT as settingsPut } from '../app/api/profiles/[profileId]/settings/route';
import { PUT as advancedPut } from '../app/api/profiles/[profileId]/advanced/route';
import { POST as importPost } from '../app/api/profiles/[profileId]/import/route';
import { POST as restorePost } from '../app/api/profiles/[profileId]/revisions/[revision]/restore/route';
import { PUT as profilePut, DELETE as profileDelete } from '../app/api/profiles/[profileId]/route';
import { PUT as orderPut } from '../app/api/profiles/[profileId]/rules/order/route';
import { PUT as batchPut } from '../app/api/profiles/[profileId]/rules/batch/route';
import { batchUpdateRules } from '../lib/rule-batch';
const temporary = mkdtempSync(path.join(os.tmpdir(), 'forge-cas-'));
const admin = ['concurrency', 'test', 'admin'].join('-');
let sequence = 0;
beforeEach(() => {
  closeDbForTests(); resetRepositoryForTests(); resetEncryptionCacheForTests();
  process.env.STASH_DB_PATH = path.join(temporary, `${++sequence}.sqlite3`);
  process.env.STASH_KEY_PATH = path.join(temporary, `${sequence}.key`);
  process.env.STASH_ADMIN_TOKEN = admin;
  delete process.env.STASH_SECRET_KEY; delete process.env.STASH_SEED_EXAMPLE;
});
after(() => { closeDbForTests(); rmSync(temporary, { recursive: true, force: true }); });
function request(method: string, revision?: number | string, body?: unknown) {
  return new Request('http://localhost/api', { method, headers: {
    'X-Admin-Token': admin, 'Content-Type': 'application/json',
    ...(revision === undefined ? {} : { 'If-Match': typeof revision === 'number' ? `"${revision}"` : revision })
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function context<T extends Record<string, string> = Record<never, never>>(id: number, extra: T = {} as T) { return { params: Promise.resolve({ profileId: String(id), ...extra }) }; }

test('snapshots expose strong ETags and writes reject absent, weak or wildcard preconditions', async () => {
  const p = getActiveProfile(); const snapshot = getSnapshot(p.id);
  const read = await snapshotGet(request('GET'), context(p.id));
  assert.equal(read.headers.get('etag'), `"${snapshot.profile.revision}"`);
  const target = context(p.id, { resource: 'hosts' });
  for (const [tag, status] of [[undefined, 428], ['*', 400], ['W/"1"', 400], ['1', 400], ['"9007199254740992"', 400]] as const) {
    const response = await resourcePost(request('POST', tag, { pattern: 'new.test', value: '192.0.2.1' }), target);
    assert.equal(response.status, status);
    assert.deepEqual(getSnapshot(p.id), snapshot);
  }
});

test('two clients with the same revision cannot both write or create extra history', async () => {
  const p = getActiveProfile(); const revision = getSnapshot(p.id).profile.revision;
  const writes = ['first.test', 'second.test'].map((pattern) => resourcePost(request('POST', revision, { pattern, value: '192.0.2.1' }), context(p.id, { resource: 'hosts' })));
  const responses = await Promise.all(writes);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal(getSnapshot(p.id).profile.revision, revision + 1);
  assert.equal(getSnapshot(p.id).hosts.length, 1);
  const conflict = await responses.find((r) => r.status === 409)!.json();
  assert.equal(conflict.code, 'revision.conflict'); assert.equal(conflict.currentRevision, revision + 1);
  assert.equal(listRevisions(p.id).items.length, 2);
});

test('stale revisions protect every configuration mutation and its compiled output atomically', async () => {
  const p = createProfile('CAS target').profile;
  const host = createHost(p.id, { pattern: 'original.test', value: '192.0.2.1' });
  const old = getSnapshot(p.id).profile.revision;
  createHost(p.id, { pattern: 'concurrent.test', value: '192.0.2.2' });
  const snapshot = getSnapshot(p.id); const history = listRevisions(p.id); const artifact = getLatestConfig(p.id);
  const cases: Array<() => Promise<Response>> = [
    () => resourcePost(request('POST', old, { pattern: 'new.test', value: '192.0.2.3' }), context(p.id, { resource: 'hosts' })),
    () => resourcePut(request('PUT', old, { pattern: 'overwrite.test', value: '192.0.2.4' }), context(p.id, { resource: 'hosts', itemId: String(host.id) })),
    () => resourceDelete(request('DELETE', old), context(p.id, { resource: 'hosts', itemId: String(host.id) })),
    () => settingsPut(request('PUT', old, { mode: 'direct', logLevel: 'silent', settings: {} }), context(p.id)),
    () => advancedPut(request('PUT', old, { sections: [] }), context(p.id)),
    () => importPost(request('POST', old, { yaml: 'rules: ["MATCH,REJECT"]' }), context(p.id)),
    () => restorePost(request('POST', old), context(p.id, { revision: '1' })),
    () => profilePut(request('PUT', old, { name: 'overwritten' }), context(p.id)),
    () => profileDelete(request('DELETE', old), context(p.id)),
    () => orderPut(request('PUT', old, { ids: snapshot.rules.map((r) => r.id) }), context(p.id)),
    () => batchPut(request('PUT', old, { ids: snapshot.rules.map((r) => r.id), policy: 'REJECT' }), context(p.id))
  ];
  for (const write of cases) {
    assert.equal((await write()).status, 409);
    assert.deepEqual(getSnapshot(p.id), snapshot); assert.deepEqual(listRevisions(p.id), history); assert.deepEqual(getLatestConfig(p.id), artifact);
  }
});

test('batch changes preserve relative order, terminal MATCH and exactly one revision', () => {
  const p = getActiveProfile();
  const rules = ['a', 'b', 'c', 'd'].map((name) => createRule(p.id, { type: 'DOMAIN', payload: `${name}.test`, policy: 'DIRECT' }));
  const revision = getSnapshot(p.id).profile.revision;
  const result = batchUpdateRules(p.id, { ids: [rules[1].id, rules[3].id], move: 'top', policy: 'REJECT', enabled: false });
  assert.equal(result.revision, revision + 1);
  assert.deepEqual(result.items.map((r) => r.payload), ['b.test', 'd.test', 'a.test', 'c.test', '']);
  assert.ok(result.items.slice(0, 2).every((r) => r.policy === 'REJECT' && !r.enabled));
  const before = getSnapshot(p.id);
  assert.throws(() => batchUpdateRules(p.id, { ids: [result.items.at(-1)!.id], enabled: false }), /MATCH/);
  assert.throws(() => batchUpdateRules(p.id, { ids: [rules[0].id, rules[0].id], enabled: true }), /不重复/);
  assert.throws(() => batchUpdateRules(p.id, { ids: [999999], enabled: true }), /不重复/);
  assert.deepEqual(getSnapshot(p.id), before);
});
