import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const launcher = path.resolve('Scripts/start-standalone.mjs');
const buildGuard = path.resolve('Scripts/check-build-data.mjs');

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'forge-startup-')));
  mkdirSync(path.join(root, 'examples'));
  writeFileSync(
    path.join(root, 'examples', 'Production.yaml'),
    'rules: ["MATCH,DIRECT"]\n'
  );
  mkdirSync(path.join(root, 'public'));
  prepareBundle(root);
  return root;
}

function prepareBundle(root: string) {
  mkdirSync(path.join(root, '.next', 'static'), { recursive: true });
  mkdirSync(path.join(root, '.next', 'standalone'), { recursive: true });
  // Stand in for the generated server: exercise the real launcher and child environment.
  writeFileSync(path.join(root, '.next', 'standalone', 'server.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const database = process.env.STASH_DB_PATH;
    const key = process.env.STASH_KEY_PATH;
    for (const file of [database, key]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, 'preserved-record', { mode: 0o600 });
    }
    console.log(JSON.stringify({ database, key, template: process.env.STASH_TEMPLATE_DIR,
      value: fs.readFileSync(database, 'utf8') }));
  `);
}

function run(script: string, root: string, overrides: Partial<NodeJS.ProcessEnv> = {}) {
  const environment = { ...process.env };
  for (const name of ['STASH_DB_PATH', 'STASH_KEY_PATH', 'STASH_TEMPLATE_DIR', 'STASH_SECRET_KEY']) {
    delete environment[name];
  }
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...environment, STASH_ADMIN_TOKEN: 'startup-fixture-only', ...overrides },
    encoding: 'utf8',
    timeout: 10_000
  });
}

test('standalone startup persists the default database and key outside rebuilt output', () => {
  const root = fixture();
  try {
    const first = run(launcher, root);
    assert.equal(first.status, 0, first.stderr);
    const info = JSON.parse(first.stdout);
    assert.equal(info.database, path.join(root, 'data', 'stash-config.sqlite3'));
    assert.equal(info.key, `${info.database}.key`);
    assert.equal(info.template, path.join(root, 'examples'));
    writeFileSync(info.database, 'saved-before-rebuild');
    assert.equal(run(buildGuard, root).status, 0);
    rmSync(path.join(root, '.next'), { recursive: true });
    prepareBundle(root);
    const second = run(launcher, root);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).value, 'saved-before-rebuild');
    assert.equal(existsSync(path.join(root, '.next', 'standalone', 'data')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone resolves relative database, key and template paths from the project root', () => {
  const root = fixture();
  try {
    const result = run(launcher, root, {
      STASH_DB_PATH: 'storage/config.sqlite3',
      STASH_KEY_PATH: 'keys/config.key',
      STASH_TEMPLATE_DIR: 'templates'
    });
    assert.equal(result.status, 0, result.stderr);
    const info = JSON.parse(result.stdout);
    assert.equal(info.database, path.join(root, 'storage', 'config.sqlite3'));
    assert.equal(info.key, path.join(root, 'keys', 'config.key'));
    assert.equal(info.template, path.join(root, 'templates'));
    const again = run(launcher, root, {
      STASH_DB_PATH: info.database,
      STASH_KEY_PATH: info.key,
      STASH_TEMPLATE_DIR: info.template
    });
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout), info);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup and prebuild refuse to ignore or erase legacy standalone database, WAL and key files', () => {
  for (const suffix of ['', '-wal', '-shm', '.key']) {
    const root = fixture();
    try {
      const legacy = path.join(root, '.next', 'standalone', 'data', `stash-config.sqlite3${suffix}`);
      mkdirSync(path.dirname(legacy), { recursive: true });
      writeFileSync(legacy, 'legacy-data');
      for (const script of [launcher, buildGuard]) {
        const result = run(script, root);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /back up the database/);
        assert.equal(readFileSync(legacy, 'utf8'), 'legacy-data');
        assert.equal(existsSync(path.join(root, 'data', 'stash-config.sqlite3')), false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('startup does not select between existing root and legacy data or create a replacement key', () => {
  const root = fixture();
  try {
    const current = path.join(root, 'data', 'stash-config.sqlite3');
    const legacy = path.join(root, '.next', 'standalone', 'data', 'stash-config.sqlite3');
    for (const file of [current, legacy]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, file === current ? 'current-data' : 'legacy-data');
    }
    assert.notEqual(run(launcher, root).status, 0);
    assert.equal(readFileSync(current, 'utf8'), 'current-data');
    assert.equal(readFileSync(legacy, 'utf8'), 'legacy-data');
    assert.equal(existsSync(`${current}.key`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup rejects new database or encryption key locations inside build output', () => {
  const root = fixture();
  try {
    for (const overrides of [
      { STASH_DB_PATH: '.next/custom/config.sqlite3' },
      { STASH_KEY_PATH: '.next/custom/key' }
    ]) {
      const result = run(launcher, root, overrides);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must be outside .next/);
      assert.equal(existsSync(path.join(root, '.next', 'custom')), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
