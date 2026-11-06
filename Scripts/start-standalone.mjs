import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');
const standaloneNext = path.join(standalone, '.next');

await mkdir(standaloneNext, { recursive: true });
await cp(path.join(root, '.next', 'static'), path.join(standaloneNext, 'static'), {
  recursive: true,
  force: true
});
await cp(path.join(root, 'public'), path.join(standalone, 'public'), {
  recursive: true,
  force: true
});

const child = spawn(process.execPath, ['server.js'], {
  cwd: standalone,
  env: process.env,
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
