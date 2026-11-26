import { workspaceRoot } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadDeployGuard, loadLinuxLayout, loadReleaseIdentity } from './support/release-tools';

/**
 * S1 of the #634 security note (threat model C11 R-ONE-2): deploy.yml checks `RUNNER_RELEASE_SHA256SUMS` against the
 * attested `SHA256SUMS` of `RUNNER_RELEASE_VERSION` before any Worker ships, with exactly the release identity the
 * runner's `update` uses. The script's own fixtures are tools/deploy-guard/check-runner-release.test.js.
 */

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}
interface Job {
  readonly needs?: string;
  readonly environment?: unknown;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly Step[];
}

const deploy = parse(readFileSync(join(workspaceRoot, '.github/workflows/deploy.yml'), 'utf8')) as {
  readonly jobs: Readonly<Record<string, Job>>;
};

describe('the deploy-time runner release check', () => {
  it('verifies with exactly the identity flags of @shared/contracts', async () => {
    const guard = await loadDeployGuard();
    const identity = await loadReleaseIdentity();
    expect(guard.attestationArgs('/tmp/SHA256SUMS', '0.2.0')).toEqual(
      identity.attestationVerifyArgs('/tmp/SHA256SUMS', '0.2.0'),
    );
    expect(guard.downloadArgs('0.2.0', '/tmp/d')).toEqual(
      identity.releaseDownloadArgs('0.2.0', 'SHA256SUMS', '/tmp/d'),
    );
    expect(guard.tarballNamesOf('0.2.0')).toEqual(
      identity.RELEASE_PLATFORMS.map((platform) => identity.tarballNameOf('0.2.0', platform)).sort(),
    );
  });

  it('runs in guard, before the deploy job and its credentials, with read-only access', () => {
    const guard = deploy.jobs['guard'];
    const step = guard?.steps?.find(
      (candidate) => candidate.run?.includes('check-runner-release.js') === true,
    );
    expect(step?.run).toBe(
      'node tools/deploy-guard/check-runner-release.js "${ENV_NAME}" apps/api/wrangler.jsonc',
    );
    expect(guard?.permissions).toEqual({ contents: 'read', attestations: 'read' });
    expect(guard?.environment).toBeUndefined();
    expect(deploy.jobs['deploy']?.needs).toBe('guard');
  });

  it('is the only source of the three vars: no deploy step overrides them with --var', () => {
    const commands = Object.values(deploy.jobs).flatMap((job) =>
      (job.steps ?? []).map((step) => JSON.stringify(step.with ?? {})),
    );
    for (const command of commands) {
      expect(command).not.toMatch(/RUNNER_RELEASE_(VERSION|SHA256SUMS|IMAGE_DIGEST)/);
    }
  });

  it('verifies the image the release workflow publishes, by digest (#634 PR 7, R-LNX)', async () => {
    const guard = await loadDeployGuard();
    const linux = await loadLinuxLayout();
    const release = parse(
      readFileSync(join(workspaceRoot, '.github/workflows/release-runner.yml'), 'utf8'),
    ) as {
      readonly env: Readonly<Record<string, string>>;
    };
    expect(guard.RUNNER_IMAGE).toBe(linux.RUNNER_IMAGE);
    expect(release.env['IMAGE']).toBe(linux.RUNNER_IMAGE);
    const digest = `sha256:${'0'.repeat(64)}`;
    expect(guard.imageSubjectOf(digest)).toBe(`oci://${linux.RUNNER_IMAGE}@${digest}`);
  });
});
