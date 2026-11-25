/**
 * Stands in for the Playwright worker in `orphan-watch.integration.spec.ts`: starts `watching-server.mts` the way
 * `local-stack.ts` starts a server — its own pid in `STACK_PARENT_PID` — says so, and stays until it is killed.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { STACK_PARENT_PID } from '../orphan-watch.mts';

const server = spawn(
  process.execPath,
  ['--experimental-strip-types', join(import.meta.dirname, 'watching-server.mts')],
  { stdio: 'inherit', env: { ...process.env, [STACK_PARENT_PID]: String(process.pid) } },
);
server.once('error', (error) => {
  process.stderr.write(`orphan-starter: ${error.message}\n`);
  process.exit(1);
});
server.once('spawn', () => {
  process.stdout.write(`starter pid=${process.pid}\n`);
});
// Without the server there is nobody to orphan; ends a run whose test never came to kill this process.
server.once('exit', () => process.exit(1));
