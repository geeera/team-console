import { workspaceRoot } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  loadNodeRuntime,
  loadReleaseIdentity,
  type NodeRuntime,
  type ReleaseIdentity,
} from './support/release-tools';

/**
 * The Node.js the runner release ships (#634 PR 5, threat model C11 R-NODE-1/R-NODE-2): the fingerprints pinned in
 * both workflows are one list and name exactly the keys of the committed keyring; Node is fetched only in a job that
 * runs no npm; every tarball holds `node` and its inner `SHA256SUMS` names it. The verifier's own fixtures are
 * tools/release/node-runtime.test.mjs.
 */

interface Step {
  readonly uses?: string;
  readonly run?: string;
}
interface Job {
  readonly needs?: string | readonly string[];
  readonly environment?: unknown;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly Step[];
}
interface Workflow {
  readonly env?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, Job>>;
}

const read = (path: string): string => readFileSync(join(workspaceRoot, path), 'utf8');
const workflow = (name: string): Workflow => parse(read(`.github/workflows/${name}`)) as Workflow;
const release = workflow('release-runner.yml');
const check = workflow('node-runtime-check.yml');
const runOf = (job: Job | undefined): string => (job?.steps ?? []).map((step) => step.run ?? '').join('\n');

describe('the bundled Node.js', () => {
  let runtime: NodeRuntime;
  let identity: ReleaseIdentity;

  beforeAll(async () => {
    runtime = await loadNodeRuntime();
    identity = await loadReleaseIdentity();
  });

  it('pins one fingerprint list in both workflows, exactly the committed keyring’s keys', () => {
    const pinned = runtime.parseFingerprints(release.env?.['NODE_RELEASE_KEY_FINGERPRINTS'] ?? '');
    expect(runtime.parseFingerprints(check.env?.['NODE_RELEASE_KEY_FINGERPRINTS'] ?? '')).toEqual(pinned);
    expect([...runtime.keyringFingerprints(read('apps/runner/node/release-keys.asc'))].sort()).toEqual(
      [...pinned].sort(),
    );
  });

  it('pins a version the launcher can run, for every release platform', () => {
    const pin = runtime.parsePin(read('apps/runner/node/node-release.json'));
    expect(pin.major).toBeGreaterThanOrEqual(22);
    expect([...runtime.PLATFORMS].sort()).toEqual([...identity.RELEASE_PLATFORMS].sort());
  });

  it('is fetched and verified only in pack, which runs no npm and can read the repository only', () => {
    const fetchers = Object.entries(release.jobs).filter(([, job]) =>
      runOf(job).includes('node-runtime.mjs fetch'),
    );
    expect(fetchers.map(([name]) => name)).toEqual(['pack']);
    const pack = release.jobs['pack'];
    expect(pack?.permissions).toEqual({ contents: 'read' });
    expect(runOf(pack)).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(pack?.environment).toBe('release');
    // The attestation covers what pack produced.
    expect(release.jobs['attest']?.needs).toBe('pack');
  });

  it('ships in every tarball, and the inner SHA256SUMS names it with the other release files', () => {
    const pack = runOf(release.jobs['pack']);
    expect(pack).toContain('for platform in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do');
    expect(pack).toContain('install -m 0555 "node/${platform}/node" "${stage}/node"');
    expect(pack).toContain(
      `sha256sum ${['team-console-runner.mjs', 'node', 'bin/job-exec', 'bin/team-console-runner'].join(' ')} > SHA256SUMS`,
    );
    expect(['team-console-runner.mjs', 'node', 'bin/job-exec', 'bin/team-console-runner'].sort()).toEqual(
      [...identity.RELEASE_FILES].sort(),
    );
    expect(pack).toContain('-cf - SHA256SUMS team-console-runner.mjs node bin');
  });

  it('is checked weekly against the signed sums and Node’s security releases, with no more than issues: write', () => {
    expect(check.jobs['check']?.permissions).toEqual({ contents: 'read', issues: 'write' });
    const run = runOf(check.jobs['check']);
    expect(run).toContain('node tools/release/node-runtime.mjs verify-sums');
    expect(run).toContain('node tools/release/node-runtime.mjs security-check');
    expect(run).toContain('--label security');
  });
});
