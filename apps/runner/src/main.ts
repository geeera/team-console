import { arch, homedir, hostname, platform } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJobExec } from './backends/job-exec';
import { runCli } from './cli/cli';

if (process.argv[2] === 'job-exec') {
  // The job side of `user`/`container` (`bin/job-exec run`): no runner state, none of the runner's signal handling.
  try {
    process.exitCode = await runJobExec(process.stdin, process.getuid?.() ?? null);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : 'job-exec failed'}\n`);
    process.exitCode = 125;
  }
} else {
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
    // `bin/job-exec` sits next to the bundle (the release tarball and the image keep that layout).
    prefix: dirname(fileURLToPath(import.meta.url)),
  });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}
