import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The image skeleton (architect note on #468, decision 12): a base pinned by digest, the bundle alone in the runtime
 * stage, root-owned and read-only, and a non-root user to run it.
 */
const dockerfile = readFileSync(join(import.meta.dirname, '../Dockerfile'), 'utf8');
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
      'FROM ${NODE_IMAGE} AS runtime',
    ]);
  });

  it('runs as a non-root user', () => {
    const users = runtime.match(/^USER (\S+)$/gm) ?? [];
    expect(users).toEqual(['USER job']);
  });

  it('carries the bundle alone into the runtime stage, root-owned and read-only', () => {
    const copies = runtime.match(/^COPY .*/gm) ?? [];
    expect(copies).toEqual([
      'COPY --from=build --chown=root:root --chmod=0555 /app/dist/apps/runner/team-console-runner.mjs /opt/team-console-runner/team-console-runner.mjs',
    ]);
    expect(runtime).not.toMatch(/node_modules|npm (ci|install)/);
  });
});
