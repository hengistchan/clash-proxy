import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { developmentRuntime } from './runtime-security.mjs';

const runtime = developmentRuntime(process.argv.slice(2));
const require = createRequire(path.join(process.cwd(), 'package.json'));
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', ...runtime.arguments], {
  env: runtime.environment,
  stdio: 'inherit'
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => process.exit(1));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
