import { RUNNER_BINARY } from '@shared/contracts';

/**
 * The runner's trust root for releases (ADR 0008 decision 10, threat model C11 rows 1–2, RR13): compiled into the
 * binary, never read from config, the console or the environment, so neither a compromised console nor a local
 * config edit can point `update` at another publisher. Verification itself is delegated to `gh attestation verify`
 * (the deviation the PR for #572 names); these constants are every identity flag it is given.
 */

export const RELEASE_HOST = 'github.com';
export const RELEASE_REPOSITORY = 'geeera/team-console';
export const RELEASE_WORKFLOW_PATH = '.github/workflows/release-runner.yml';
export const RELEASE_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const RELEASE_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';

/** The only ref a release may be built from: the `v<version>` tag the console names (the owner's tag ruleset, #575). */
export const releaseTagOf = (version: string): string => `v${version}`;
export const releaseRefOf = (version: string): string => `refs/tags/${releaseTagOf(version)}`;

export const RELEASE_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

/** The release platform of a Node `process.platform`/`process.arch` pair, or `null` when none is published. */
export function releasePlatformOf(platform: string, arch: string): ReleasePlatform | null {
  const candidate = `${platform}-${arch}`;
  return (RELEASE_PLATFORMS as readonly string[]).includes(candidate) ? (candidate as ReleasePlatform) : null;
}

/** `team-console-runner-<version>-<platform>.tar.gz`, the asset name `release-runner.yml` uploads. */
export const tarballNameOf = (version: string, platform: ReleasePlatform): string =>
  `${RUNNER_BINARY}-${version}-${platform}.tar.gz`;

/** What every tarball holds, flat (extracted straight into the install directory), and nothing else. */
export const BUNDLE_FILE = `${RUNNER_BINARY}.mjs`;
export const RELEASE_FILES = [BUNDLE_FILE, 'bin/job-exec', `bin/${RUNNER_BINARY}`] as const;
export const RELEASE_SUMS_FILE = 'SHA256SUMS';

/** The exact `gh attestation verify` argument list for one downloaded tarball. */
export function attestationVerifyArgs(tarball: string, version: string): string[] {
  return [
    'attestation',
    'verify',
    tarball,
    '--hostname',
    RELEASE_HOST,
    '--repo',
    RELEASE_REPOSITORY,
    '--signer-workflow',
    `${RELEASE_HOST}/${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}`,
    '--source-ref',
    releaseRefOf(version),
    '--cert-oidc-issuer',
    RELEASE_OIDC_ISSUER,
    '--predicate-type',
    RELEASE_PREDICATE_TYPE,
    '--deny-self-hosted-runners',
  ];
}

/** `gh release download` of one asset from the pinned repository's `v<version>` release. */
export function releaseDownloadArgs(version: string, asset: string, dir: string): string[] {
  return [
    'release',
    'download',
    releaseTagOf(version),
    '--repo',
    `${RELEASE_HOST}/${RELEASE_REPOSITORY}`,
    '--pattern',
    asset,
    '--dir',
    dir,
  ];
}
