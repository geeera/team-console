import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { managedSettingsText } from './backends/user';

/**
 * The runner image (architect note on #468, decision 12): a base pinned by digest, the Claude Code CLI pinned by
 * version, the bundle, `job-exec` and the managed settings root-owned and read-only in the runtime stage, and a
 * non-root user to run it.
 */
const app = join(import.meta.dirname, '..');
const dockerfile = readFileSync(join(app, 'Dockerfile'), 'utf8');
const instructions = dockerfile
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  .join('\n');
const runtime = instructions.slice(instructions.lastIndexOf('FROM '));

describe('apps/runner/Dockerfile', () => {
  it('pins the base image by digest', () => {
    expect(instructions).toMatch(/^ARG NODE_IMAGE=node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    expect(instructions.match(/^FROM .*/gm)).toEqual([
      'FROM ${NODE_IMAGE} AS build',
      'FROM ${NODE_IMAGE} AS cli',
      'FROM ${NODE_IMAGE} AS runtime',
    ]);
  });

  it('pins the Claude Code CLI to one exact version', () => {
    expect(instructions).toMatch(/^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m);
    expect(instructions).toContain('"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
  });

  it('runs as a non-root user', () => {
    const users = runtime.match(/^USER (\S+)$/gm) ?? [];
    expect(users).toEqual(['USER job']);
  });

  it('carries the CLI, the bundle, job-exec and the managed settings into the runtime stage, root-owned', () => {
    const copies = runtime.match(/^COPY .*/gm) ?? [];
    expect(copies).toEqual([
      'COPY --from=cli --chown=root:root /usr/local/lib/node_modules/@anthropic-ai/claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code',
      'COPY --from=build --chown=root:root --chmod=0555 /app/dist/apps/runner/team-console-runner.mjs /opt/team-console-runner/team-console-runner.mjs',
      'COPY --from=build --chown=root:root --chmod=0555 /app/apps/runner/bin/job-exec /opt/team-console-runner/bin/job-exec',
      'COPY --from=build --chown=root:root --chmod=0444 /app/apps/runner/managed-settings.json /etc/claude-code/managed-settings.json',
    ]);
    expect(runtime).not.toMatch(/node_modules\/\.bin|npm (ci|install)/);
  });

  it('makes the managed-settings directory traversable before copying into it', () => {
    const made = runtime.indexOf('install -d -m 0755 /etc/claude-code');
    expect(made).toBeGreaterThan(-1);
    expect(made).toBeLessThan(runtime.indexOf('/etc/claude-code/managed-settings.json'));
  });

  it('ships exactly the runner’s managed settings', () => {
    expect(readFileSync(join(app, 'managed-settings.json'), 'utf8')).toBe(managedSettingsText());
  });
});
