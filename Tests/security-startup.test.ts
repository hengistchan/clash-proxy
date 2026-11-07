import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertRuntimeSecurity } from '../Scripts/runtime-security.mjs';
import { developmentRuntime } from '../Scripts/runtime-security.mjs';

const launchers = ['Scripts/start-standalone.mjs', 'Scripts/start-container.mjs'].map((file) => path.resolve(file));
function environment(overrides: Partial<NodeJS.ProcessEnv>) {
  const result = { ...process.env };
  for (const key of ['STASH_ADMIN_TOKEN', 'STASH_ALLOW_INSECURE_LOCAL', 'STASH_DB_PATH', 'STASH_KEY_PATH']) delete result[key];
  return { ...result, ...overrides };
}

test('both production launchers reject missing authentication before opening or creating data', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forge-secure-start-'));
  try {
    writeFileSync(path.join(root, 'server.js'), "require('node:fs').writeFileSync('server-started', 'unsafe');");
    for (const launcher of launchers) {
      for (const overrides of [
        { NODE_ENV: 'production' as const },
        { NODE_ENV: 'development' as const, STASH_ALLOW_INSECURE_LOCAL: '1', HOSTNAME: '127.0.0.1' }
      ]) {
        const result = spawnSync(process.execPath, [launcher], { cwd: root, env: environment(overrides), encoding: 'utf8', timeout: 5_000 });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /STASH_ADMIN_TOKEN is required/);
        assert.equal(existsSync(path.join(root, 'server-started')), false);
        assert.equal(existsSync(path.join(root, 'data')), false);
        assert.equal(existsSync(path.join(root, '.next')), false);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the container entrypoint starts an authenticated production server and preserves its exit code', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forge-container-start-'));
  try {
    mkdirSync(path.join(root, 'data'));
    writeFileSync(path.join(root, 'server.js'), "require('node:fs').writeFileSync('server-started', process.env.NODE_ENV); process.exit(7);");
    const result = spawnSync(process.execPath, [launchers[1]], { cwd: root, env: environment({ STASH_ADMIN_TOKEN: 'fixture-startup-only' }), encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 7, result.stderr);
    assert.equal(existsSync(path.join(root, 'server-started')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an insecure development runtime must explicitly bind a loopback address', () => {
  const insecure = { NODE_ENV: 'development' as const, STASH_ALLOW_INSECURE_LOCAL: '1' } as NodeJS.ProcessEnv;
  for (const host of [undefined, '0.0.0.0', '::', 'forge.example.test']) {
    assert.throws(() => assertRuntimeSecurity({ ...insecure, HOSTNAME: host }), /STASH_ADMIN_TOKEN is required/);
  }
  for (const host of ['localhost', '127.0.0.1', '::1']) assert.doesNotThrow(() => assertRuntimeSecurity({ ...insecure, HOSTNAME: host }));
});

test('development hostname parsing rejects all non-loopback forms before launching Next', () => {
  const insecure = { NODE_ENV: 'development', STASH_ALLOW_INSECURE_LOCAL: '1' } as NodeJS.ProcessEnv;
  for (const args of [
    ['--hostname', '0.0.0.0'], ['--hostname=0.0.0.0'], ['-H', '::'],
    ['-H0.0.0.0'], ['-H=0.0.0.0'], ['--hostname', 'localhost', '-H0.0.0.0'],
    ['--hostname'], ['--hostname='], ['-H'], ['--hostname', 'forge.example.test'], ['--'], ['--', '--hostname', 'localhost']
  ]) assert.throws(() => developmentRuntime(args, insecure), /loopback hostname/);
  for (const args of [[], ['--port', '3010'], ['-Hlocalhost'], ['-H=::1'], ['--hostname=localhost'], ['--hostname', '127.0.0.1']]) {
    const runtime = developmentRuntime(args, insecure);
    assert.equal(runtime.environment.HOSTNAME, '127.0.0.1');
    assert.equal(runtime.environment.NODE_ENV, 'development');
    assert.deepEqual(runtime.arguments.slice(-2), ['--hostname', '127.0.0.1']);
  }
  assert.throws(() => developmentRuntime([], {} as NodeJS.ProcessEnv), /STASH_ADMIN_TOKEN is required/);
});

test('the development launcher passes only safe insecure bindings to the real child entrypoint', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forge-development-start-'));
  try {
    const binary = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}');
    writeFileSync(binary, "console.log(JSON.stringify({args:process.argv.slice(2), hostname:process.env.HOSTNAME, mode:process.env.NODE_ENV})); process.exit(6);");
    const launcher = path.resolve('Scripts/start-development.mjs');
    for (const args of [[], ['--port', '3010'], ['--hostname=localhost'], ['-H::1']]) {
      const result = spawnSync(process.execPath, [launcher, ...args], { cwd: root, env: environment({ STASH_ALLOW_INSECURE_LOCAL: '1', HOSTNAME: '0.0.0.0' }), encoding: 'utf8', timeout: 5_000 });
      assert.equal(result.status, 6, result.stderr);
      const child = JSON.parse(result.stdout);
      assert.deepEqual(child.args.slice(-2), ['--hostname', '127.0.0.1']);
      assert.equal(child.args[0], 'dev');
      assert.equal(child.hostname, '127.0.0.1');
      assert.equal(child.mode, 'development');
    }
    const rejected = spawnSync(process.execPath, [launcher, '--hostname=0.0.0.0'], { cwd: root, env: environment({ STASH_ALLOW_INSECURE_LOCAL: '1' }), encoding: 'utf8', timeout: 5_000 });
    assert.notEqual(rejected.status, 6);
    assert.match(rejected.stderr, /loopback hostname/);
    assert.equal(rejected.stdout, '');
    const authenticated = spawnSync(process.execPath, [launcher, '--hostname', '0.0.0.0'], { cwd: root, env: environment({ STASH_ADMIN_TOKEN: '{{SECRET_1gg3wmd3}}' }), encoding: 'utf8', timeout: 5_000 });
    assert.equal(authenticated.status, 6, authenticated.stderr);
    assert.deepEqual(JSON.parse(authenticated.stdout).args, ['dev', '--hostname', '0.0.0.0']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
