import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'forge-browser-')));
const environment = {
  ...process.env,
  NODE_ENV: 'production',
  HOSTNAME: '127.0.0.1',
  PORT: '3117',
  STASH_DB_PATH: path.join(temporary, 'config.sqlite3'),
  STASH_KEY_PATH: path.join(temporary, 'config.key'),
  STASH_ADMIN_TOKEN: ['browser', 'test', 'admin'].join('-'),
  STASH_PUBLIC_BASE_URL: 'http://127.0.0.1:3117',
  STASH_TEMPLATE_DIR: process.cwd()
};
delete environment.STASH_SECRET_KEY;
delete environment.STASH_SEED_EXAMPLE;

const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['start'], {
  env: environment,
  stdio: 'inherit',
  detached: process.platform !== 'win32'
});
let stopping = false;
let forceStop;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (process.platform === 'win32') child.kill(signal);
  else {
    try { process.kill(-child.pid, signal); } catch { /* The child may have exited. */ }
  }
  forceStop = setTimeout(() => {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
    process.exit(1);
  }, 5_000);
  forceStop.unref();
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('exit', () => rmSync(temporary, { recursive: true, force: true }));
child.on('error', (error) => {
  console.error(`Unable to start browser test server: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code) => {
  clearTimeout(forceStop);
  process.exit(stopping ? 0 : code || 1);
});
