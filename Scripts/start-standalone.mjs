import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { standaloneEnvironment } from './standalone-paths.mjs';

const root = process.cwd();
// Resolve persistent paths before server.js changes the working directory.
const environment = standaloneEnvironment(root);
const standalone = path.join(root, '.next', 'standalone');
const standaloneNext = path.join(standalone, '.next');

await mkdir(standaloneNext, { recursive: true });
await cp(
  path.join(root, '.next', 'static'),
  path.join(standaloneNext, 'static'),
  {
    recursive: true,
    force: true
  }
);
await cp(path.join(root, 'public'), path.join(standalone, 'public'), {
  recursive: true,
  force: true
});

await mkdir(path.join(standalone, 'examples'), { recursive: true });
await cp(
  path.join(root, 'examples', 'Production.yaml'),
  path.join(standalone, 'examples', 'Production.yaml')
);

const child = spawn(process.execPath, ['server.js'], {
  cwd: standalone,
  env: environment,
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
