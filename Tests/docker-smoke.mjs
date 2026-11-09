import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const image = process.argv[2] || 'stash-config-forge:audit';
const name = `forge-audit-${randomBytes(6).toString('hex')}`;
const admin = randomBytes(32).toString('base64url');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const missing = spawnSync('docker', ['run', '--rm', '--env', 'NODE_ENV=development', '--env', 'STASH_ALLOW_INSECURE_LOCAL=1', image], { encoding: 'utf8', timeout: 30_000 });
assert.equal(missing.error, undefined);
assert.notEqual(missing.status, 0, 'Production images must refuse missing authentication even with development flags');
assert.match(missing.stderr, /STASH_ADMIN_TOKEN is required/);
let started = false;
try {
  execFileSync('docker', ['run', '--detach', '--rm', '--name', name,
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--tmpfs', '/data:rw,uid=10001,gid=10001,mode=0700', '--tmpfs', '/tmp:rw,mode=1777',
    '--publish', '127.0.0.1::8080', '--env', 'STASH_ADMIN_TOKEN', image],
    { env: { ...process.env, STASH_ADMIN_TOKEN: admin }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  started = true;
  const base = `http://${docker('port', name, '8080/tcp').split('\n')[0]}`;
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { healthy = true; break; } } catch { /* Startup in progress. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(healthy, 'Authenticated production container must become healthy');
  assert.equal(docker('exec', name, 'id', '-u'), '10001');
  assert.equal(docker('inspect', '--format', '{{.HostConfig.ReadonlyRootfs}}', name), 'true');
  assert.equal((await fetch(`${base}/api/profiles`)).status, 401);
  const headers = { 'X-Admin-Token': admin };
  const profiles = await (await fetch(`${base}/api/profiles`, { headers })).json();
  const id = profiles.items[0].id;
  const read = await fetch(`${base}/api/profiles/${id}/snapshot`, { headers });
  assert.equal(read.status, 200);
  const etag = read.headers.get('etag');
  assert.match(etag, /^"\d+"$/);
  const results = await Promise.all(['first', 'second'].map((label) => fetch(`${base}/api/profiles/${id}/hosts`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'If-Match': etag },
    body: JSON.stringify({ pattern: `${label}.container.test`, value: '192.0.2.1' })
  })));
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  const delivered = await fetch(`${base}/api/profiles/${id}/config_download`, { headers });
  assert.equal(delivered.status, 200);
  assert.match(await delivered.text(), /container\.test/);
  for (const target of ['', '/mihomo']) {
    const endpoint = `${base}/api/profiles/${id}${target}/download-link`;
    const linkResponse = await fetch(endpoint, { method: 'POST', headers });
    assert.equal(linkResponse.status, 200);
    const { subscriptionPath } = await linkResponse.json();
    const subscription = await fetch(base + subscriptionPath);
    assert.equal(subscription.status, 200);
    assert.match(await subscription.text(), /container\.test/);
    assert.equal((await fetch(endpoint, { method: 'DELETE', headers })).status, 204);
    assert.equal((await fetch(base + subscriptionPath)).status, 404);
  }
  console.log('PASS: real non-root/read-only production container, mandatory auth, atomic CAS, delivery and revocation');
} finally {
  if (started) docker('rm', '--force', name);
}
