import { workspaceRoot } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASE_PLATFORMS, attestationVerifyArgs, releaseDownloadArgs, tarballNameOf } from '@shared/contracts';
import { parse } from 'yaml';
import { attestationArgs, downloadArgs, tarballNamesOf } from '../../deploy-guard/check-runner-release.js';

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
  it('verifies with exactly the identity flags of @shared/contracts', () => {
    expect(attestationArgs('/tmp/SHA256SUMS', '0.2.0')).toEqual(attestationVerifyArgs('/tmp/SHA256SUMS', '0.2.0'));
    expect(downloadArgs('0.2.0', '/tmp/d')).toEqual(releaseDownloadArgs('0.2.0', 'SHA256SUMS', '/tmp/d'));
    expect(tarballNamesOf('0.2.0')).toEqual(RELEASE_PLATFORMS.map((platform) => tarballNameOf('0.2.0', platform)).sort());
  });

  it('runs in guard, before the deploy job and its credentials, with read-only access', () => {
    const guard = deploy.jobs['guard'];
    const step = guard?.steps?.find((candidate) => candidate.run?.includes('check-runner-release.js') === true);
    expect(step?.run).toBe('node tools/deploy-guard/check-runner-release.js "${ENV_NAME}" apps/api/wrangler.jsonc');
    expect(guard?.permissions).toEqual({ contents: 'read', attestations: 'read' });
    expect(guard?.environment).toBeUndefined();
    expect(deploy.jobs['deploy']?.needs).toBe('guard');
  });

  it('is the only source of the two vars: no deploy step overrides them with --var', () => {
    const commands = Object.values(deploy.jobs).flatMap((job) => (job.steps ?? []).map((step) => JSON.stringify(step.with ?? {})));
    for (const command of commands) {
      expect(command).not.toMatch(/RUNNER_RELEASE_(VERSION|SHA256SUMS)/);
    }
  });
});
