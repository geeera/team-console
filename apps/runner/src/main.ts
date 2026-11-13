import { arch, homedir, hostname, platform } from 'node:os';
import { runCli } from './cli/cli';

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  homeDir: homedir(),
  host: { os: platform(), arch: arch(), hostname: hostname() },
  fetch: (url, init) => fetch(url, init),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
