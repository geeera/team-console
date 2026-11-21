import { RUNNER_BINARY, compareRunnerVersions } from './runner';

/**
 * The runner's release identity (ADR 0008 decision 10, threat model C11 rows 1–2, RR13; #634 PR 5): one place for the
 * runner's `update`, the console's install command and the deploy guard's attestation check. Every member is a
 * compile-time constant or a pure function of its arguments: nothing here reads the environment, a config file or a
 * console answer, so neither a compromised console nor a local edit can point a verification at another publisher
 * (`tools/workspace-checks/src/runner-release-identity.spec.ts` keeps it that way).
 */

export const RELEASE_HOST = 'github.com';
export const RELEASE_REPOSITORY = 'geeera/team-console';
export const RELEASE_WORKFLOW_PATH = '.github/workflows/release-runner.yml';
export const RELEASE_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const RELEASE_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';

/** The label `release-runner.yml` builds from a `v<label>` tag: SemVer core with an optional pre-release, no build. */
const RELEASE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
export const isReleaseVersion = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && RELEASE_VERSION.test(value);

/** The only ref a release may be built from: the `v<version>` tag (the owner's tag ruleset, #575). */
export const releaseTagOf = (version: string): string => `v${version}`;
export const releaseRefOf = (version: string): string => `refs/tags/${releaseTagOf(version)}`;

export const RELEASE_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

/** The macOS platforms: the `user` backend and the verified-download one-liner exist only there. */
export const MAC_RELEASE_PLATFORMS = ['darwin-arm64', 'darwin-x64'] as const satisfies readonly ReleasePlatform[];
export type MacReleasePlatform = (typeof MAC_RELEASE_PLATFORMS)[number];

/** The release platform of a Node `process.platform`/`process.arch` pair, or `null` when none is published. */
export function releasePlatformOf(platform: string, arch: string): ReleasePlatform | null {
  const candidate = `${platform}-${arch}`;
  return (RELEASE_PLATFORMS as readonly string[]).includes(candidate) ? (candidate as ReleasePlatform) : null;
}

/** `team-console-runner-<version>-<platform>.tar.gz`, the asset name `release-runner.yml` uploads. */
export const tarballNameOf = (version: string, platform: ReleasePlatform): string =>
  `${RUNNER_BINARY}-${version}-${platform}.tar.gz`;

/** `https://github.com/<repository>/releases/download/v<version>/<tarball>`: the URL is built, never configured. */
export const tarballUrlOf = (version: string, platform: ReleasePlatform): string =>
  `https://${RELEASE_HOST}/${RELEASE_REPOSITORY}/releases/download/${releaseTagOf(version)}/${tarballNameOf(version, platform)}`;

/** Where `setup` installs a release on macOS (ADR 0008 decision 11): root-owned, named by the plist and sudoers. */
export const RUNNER_INSTALL_PREFIX = '/usr/local/lib/team-console-runner';
/** The installed launcher: what the runbook and the console's `setup` command run with sudo. */
export const RUNNER_INSTALLED_LAUNCHER = `${RUNNER_INSTALL_PREFIX}/bin/${RUNNER_BINARY}`;

export const BUNDLE_FILE = `${RUNNER_BINARY}.mjs`;
/**
 * The Node.js binary each tarball ships for its platform (#634 PR 5, R-NODE-1): pinned and verified in the release
 * workflow, root-owned 0555 in the prefix, and what the LaunchDaemon and the launcher run as root.
 */
export const NODE_FILE = 'node';
/** What every tarball holds, flat (extracted straight into the install directory), and nothing else. */
export const RELEASE_FILES = [BUNDLE_FILE, NODE_FILE, 'bin/job-exec', `bin/${RUNNER_BINARY}`] as const;
export const RELEASE_SUMS_FILE = 'SHA256SUMS';

/**
 * The first release built with `node` inside (S2 of the #634 security note): an older release's launcher looks for a
 * node elsewhere, so the console offers the macOS one-liner only from this version on.
 */
export const NODE_BUNDLED_SINCE = '0.2.0';

export function isNodeBundled(version: string): boolean {
  const order = compareRunnerVersions(version, NODE_BUNDLED_SINCE);
  return order !== null && order >= 0;
}

/**
 * The exact `gh attestation verify` argument list for one release asset (a tarball or the release's `SHA256SUMS`):
 * built by the pinned workflow, from the version's tag, on a GitHub-hosted runner.
 */
export function attestationVerifyArgs(asset: string, version: string): string[] {
  return [
    'attestation',
    'verify',
    asset,
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

const SUMS_LINE = /^([0-9a-f]{64}) {2}(\S+)$/;

/**
 * The release's `SHA256SUMS` as `release-runner.yml` writes it (`sha256sum -- *.tar.gz`): one `<64 hex>  <tarball>`
 * line for each platform's tarball of `version`, sorted by name, each ending in a newline, and nothing else. Anything
 * else is `null` (R-ONE-2: the Worker refuses a malformed `RUNNER_RELEASE_SHA256SUMS` before it names a sum).
 */
export function releaseSumsOf(text: string, version: string): Readonly<Record<ReleasePlatform, string>> | null {
  if (!isReleaseVersion(version) || !text.endsWith('\n')) {
    return null;
  }
  const lines = text.slice(0, -1).split('\n');
  const expected = RELEASE_PLATFORMS.map((platform) => ({ platform, name: tarballNameOf(version, platform) })).sort(
    (a, b) => (a.name < b.name ? -1 : 1),
  );
  if (lines.length !== expected.length) {
    return null;
  }
  const sums: Partial<Record<ReleasePlatform, string>> = {};
  for (const [index, line] of lines.entries()) {
    const match = SUMS_LINE.exec(line);
    const want = expected[index];
    if (match === null || want === undefined || match[2] !== want.name || match[1] === undefined) {
      return null;
    }
    sums[want.platform] = match[1];
  }
  return sums as Record<ReleasePlatform, string>;
}
