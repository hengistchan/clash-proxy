import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { pruneRevisionHistory, revisionRetentionLimit, revisionRetentionStatus } from '../lib/history-retention';

afterEach(() => { delete process.env.STASH_REVISION_LIMIT; });
function fixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE profiles(id INTEGER PRIMARY KEY,revision INTEGER); CREATE TABLE revisions(profile_id INTEGER,revision INTEGER,config_ciphertext TEXT); CREATE TABLE compiled_configs(profile_id INTEGER,revision INTEGER); CREATE TABLE shadowrocket_compilations(profile_id INTEGER,revision INTEGER); CREATE TABLE mihomo_compilations(profile_id INTEGER,revision INTEGER,artifact_ciphertext TEXT,created_at TEXT); CREATE TABLE target_publications(profile_id INTEGER,revision INTEGER); INSERT INTO profiles VALUES(1,33),(2,33); INSERT INTO compiled_configs VALUES(1,2),(2,32);');
  const insert = db.prepare('INSERT INTO revisions VALUES(?,?,?)');
  for (let index = 1; index <= 33; index++) { insert.run(1, index, 'encrypted'); insert.run(2, index, 'encrypted'); }
  return db;
}

test('history retention bounds recent snapshots while protecting old successful and current revisions', () => {
  process.env.STASH_REVISION_LIMIT = '10';
  const db = fixture();
  try {
    assert.equal(pruneRevisionHistory(db, 1), 22);
    const revisions = (db.prepare('SELECT revision FROM revisions WHERE profile_id=1 ORDER BY revision').all() as { revision: number }[]).map((row) => row.revision);
    assert.deepEqual(revisions, [2,24,25,26,27,28,29,30,31,32,33]);
    assert.deepEqual(revisionRetentionStatus(db, 1), { retentionLimit: 10, retainedCount: 11, oldestRevision: 2 });
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM revisions WHERE profile_id=2').get() as { count: number }).count, 33);
    assert.equal(pruneRevisionHistory(db, 1), 0);
    db.prepare('UPDATE compiled_configs SET revision=33 WHERE profile_id=1').run();
    db.prepare('INSERT INTO shadowrocket_compilations VALUES (1,2)').run();
    assert.equal(pruneRevisionHistory(db, 1), 0);
    db.prepare('UPDATE shadowrocket_compilations SET revision=33 WHERE profile_id=1').run();
    db.prepare("INSERT INTO mihomo_compilations VALUES (1,2,'encrypted','today')").run();
    assert.equal(pruneRevisionHistory(db, 1), 0);
    db.prepare('DELETE FROM mihomo_compilations').run();
    db.prepare('INSERT INTO target_publications VALUES (1,2)').run();
    assert.equal(pruneRevisionHistory(db, 1), 0);
    db.prepare('DELETE FROM target_publications').run();
    assert.equal(pruneRevisionHistory(db, 1), 1);
    assert.equal(revisionRetentionStatus(db, 1).retainedCount, 10);
  } finally { db.close(); }
});

test('retention configuration is bounded and rejects invalid values before deleting anything', () => {
  const db = fixture();
  try {
    delete process.env.STASH_REVISION_LIMIT;
    assert.equal(revisionRetentionLimit(), 200); assert.equal(pruneRevisionHistory(db, 1), 0);
    for (const value of ['0', '-1', '9', '10001', '10.5', 'abc']) {
      process.env.STASH_REVISION_LIMIT = value;
      assert.throws(() => pruneRevisionHistory(db, 1), /STASH_REVISION_LIMIT/);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM revisions WHERE profile_id=1').get() as { count: number }).count, 33);
    }
  } finally { db.close(); }
});
