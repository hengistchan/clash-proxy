import { spawn } from 'node:child_process';
import { assertRuntimeSecurity } from './runtime-security.mjs';

assertRuntimeSecurity({ ...process.env, NODE_ENV: 'production' });
const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, NODE_ENV: 'production' },
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
