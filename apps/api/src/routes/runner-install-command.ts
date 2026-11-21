import {
  MAC_RELEASE_PLATFORMS,
  isEnrolmentIntentId,
  isNodeBundled,
  isReleaseVersion,
  releaseSumsOf,
  tarballUrlOf,
  type MacReleasePlatform,
  type ReleasePlatform,
  type RunnerInstallCommandsDto,
} from '@shared/contracts';
import type { ApiEnv } from '../env';

/**
 * The macOS first-install one-liner (#634 PR 5; threat model C11 R-ONE-1, R-ONE-2). Every part is either a
 * compile-time constant of `@shared/contracts` (the repository, the asset name, the install path) or a value checked
 * here against a strict shape: the version (SemVer), the sum (64 hex, from `RUNNER_RELEASE_SHA256SUMS`, which deploy.yml
 * compared with the attested `SHA256SUMS` before this Worker shipped), the origin (the configured
 * `CONSOLE_PUBLIC_ORIGIN`, never the request's `Host`) and the intent id (a ULID). None of them can carry a quote, a
 * space or a shell metacharacter, so the text is safe to paste. Anything off is `null`: no command rather than a
 * surprising one.
 */

const HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface MacInstallCommandInput {
  readonly origin: string;
  readonly version: string;
  readonly platform: MacReleasePlatform;
  readonly sha256: string;
  readonly intentId: string;
}

/**
 * As the operator (curl, checked by shasum before sudo asks for anything), then as root: copy the tarball into a
 * fresh 0700 directory under `/var/root` (root-owned up to `/`, so the launcher accepts the node inside, S2), hash
 * that copy again (the operator's file could change after the first check), unpack it there and run `setup`, which
 * copies and re-hashes once more before it installs (R-ONE-1). The root directory is removed whatever `setup` answers.
 */
export function macInstallCommandOf(input: MacInstallCommandInput): string | null {
  const { origin, version, platform, sha256, intentId } = input;
  if (
    !HTTPS_ORIGIN.test(origin) ||
    !isReleaseVersion(version) ||
    !isNodeBundled(version) ||
    !(MAC_RELEASE_PLATFORMS as readonly string[]).includes(platform) ||
    !SHA256.test(sha256) ||
    !isEnrolmentIntentId(intentId)
  ) {
    return null;
  }
  const asRoot = [
    's=$(/usr/bin/mktemp -d /var/root/tcr.XXXXXX)',
    '/bin/cp "$1" "$s/tcr.tgz"',
    `echo "${sha256}  $s/tcr.tgz" | /usr/bin/shasum -a 256 -c -`,
    '/usr/bin/tar -xzf "$s/tcr.tgz" -C "$s"',
  ].join(' && ');
  const setup = `"$s/bin/team-console-runner" setup --url ${origin} --enrolment ${intentId} --release "$s/tcr.tgz" --sha256 ${sha256}`;
  return [
    'd=$(mktemp -d)',
    `curl --proto '=https' --tlsv1.2 -fsSLo "$d/tcr.tgz" ${tarballUrlOf(version, platform)}`,
    `echo "${sha256}  $d/tcr.tgz" | shasum -a 256 -c -`,
    `sudo /bin/sh -c '${asRoot} && { ${setup}; r=$?; /bin/rm -rf "$s"; exit $r; }' sh "$d/tcr.tgz"`,
  ].join(' && ');
}

/**
 * The release this environment names, with the sum of each platform, or `null`: no version, a version below the
 * first that ships `node`, or sums that are not exactly that release's `SHA256SUMS` (R-ONE-2, the Worker's own check
 * beside deploy.yml's).
 */
export function namedRunnerReleaseOf(
  env: Pick<ApiEnv, 'RUNNER_RELEASE_VERSION' | 'RUNNER_RELEASE_SHA256SUMS'>,
): { readonly version: string; readonly sums: Readonly<Record<ReleasePlatform, string>> } | null {
  const version = env.RUNNER_RELEASE_VERSION ?? '';
  if (!isReleaseVersion(version) || !isNodeBundled(version)) {
    return null;
  }
  const sums = releaseSumsOf(env.RUNNER_RELEASE_SHA256SUMS ?? '', version);
  return sums === null ? null : { version, sums };
}

/** Both Mac one-liners for an intent, or `null` when either cannot be built. */
export function macInstallCommandsOf(
  env: Pick<ApiEnv, 'RUNNER_RELEASE_VERSION' | 'RUNNER_RELEASE_SHA256SUMS'>,
  origin: string | null,
  intentId: string,
): RunnerInstallCommandsDto | null {
  const release = namedRunnerReleaseOf(env);
  if (release === null || origin === null) {
    return null;
  }
  const commandOf = (platform: MacReleasePlatform): string | null =>
    macInstallCommandOf({ origin, version: release.version, platform, sha256: release.sums[platform], intentId });
  const arm = commandOf('darwin-arm64');
  const intel = commandOf('darwin-x64');
  return arm === null || intel === null ? null : { version: release.version, 'darwin-arm64': arm, 'darwin-x64': intel };
}
