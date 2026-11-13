import { arch, homedir, hostname, platform } from 'node:os';
import { runCli } from './cli/cli';

// The first Ctrl-C (or SIGTERM) finishes a running job `failed` with `runner-shutdown`; a second one exits at once.
const shutdown = new AbortController();
const onSignal = (): void => {
  if (shutdown.signal.aborted) {
    process.exit(130);
  }
  process.stderr.write(
    'Stopping: the running job is finished as failed (runner-shutdown). Ctrl-C again to exit now.\n',
  );
  shutdown.abort();
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  homeDir: homedir(),
  host: { os: platform(), arch: arch(), hostname: hostname() },
  fetch: (url, init) => fetch(url, init),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  shutdown: shutdown.signal,
});
process.off('SIGINT', onSignal);
process.off('SIGTERM', onSignal);
