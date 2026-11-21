import {
  ENROLMENT_INTENT_ENV,
  LINUX_PODMAN_SOCKET,
  LINUX_PODMAN_SOCKET_IN_RUNNER,
  LINUX_PODMAN_UNIT,
  LINUX_RUNNER_HOME,
  LINUX_RUNNER_UNIT,
  LINUX_RUNNER_USER,
  LINUX_STATE_DIR,
  LINUX_UNIT_DIR,
  MAC_RELEASE_PLATFORMS,
  isEnrolmentIntentId,
  isImageDigest,
  isLinuxSetupShipped,
  isNodeBundled,
  isReleaseVersion,
  releaseSumsOf,
  runnerImageRefOf,
  tarballUrlOf,
  type LinuxInstallCommandsDto,
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

/**
 * The image this environment names for Linux (R-LNX), or `null`: no release, a release before `LINUX_SETUP_SINCE`, or
 * a digest that is not `sha256:<64 hex>`. deploy.yml has proved the digest was built by the release workflow from the
 * version's tag before this Worker shipped.
 */
export function namedRunnerImageOf(
  env: Pick<ApiEnv, 'RUNNER_RELEASE_VERSION' | 'RUNNER_RELEASE_IMAGE_DIGEST'>,
): { readonly version: string; readonly image: string } | null {
  const version = env.RUNNER_RELEASE_VERSION ?? '';
  const digest = env.RUNNER_RELEASE_IMAGE_DIGEST ?? '';
  if (!isReleaseVersion(version) || !isLinuxSetupShipped(version) || !isImageDigest(digest)) {
    return null;
  }
  return { version, image: runnerImageRefOf(version, digest) };
}

/** What both units share: the dedicated user, its state directory, and the hardening R-LNX names. */
const UNIT_SERVICE_BASE = [
  `User=${LINUX_RUNNER_USER}`,
  `Group=${LINUX_RUNNER_USER}`,
  'StateDirectory=team-console-runner',
  'StateDirectoryMode=0700',
  `WorkingDirectory=${LINUX_STATE_DIR}`,
  'NoNewPrivileges=yes',
  'ProtectSystem=strict',
  'ProtectHome=yes',
  'PrivateTmp=yes',
];

/**
 * Rootless podman's API of `tcrunner`, on a socket in that user's 0700 state directory: the only runtime socket the
 * runner's container gets, never a `docker.sock` (R-LNX). `RuntimeDirectory` is podman's run root, because
 * `ProtectHome=yes` hides `/run/user`.
 */
export function podmanUnitOf(): string {
  return [
    '[Unit]',
    `Description=Team Console runner: rootless podman API of ${LINUX_RUNNER_USER}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    ...UNIT_SERVICE_BASE,
    'RuntimeDirectory=team-console-runner',
    'RuntimeDirectoryMode=0700',
    `Environment=HOME=${LINUX_STATE_DIR} XDG_RUNTIME_DIR=/run/team-console-runner`,
    `ExecStartPre=/usr/bin/install -d -m 0700 ${LINUX_RUNNER_HOME}`,
    `ExecStart=/usr/bin/podman system service --time=0 unix://${LINUX_PODMAN_SOCKET}`,
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');
}

/**
 * How the service and the enrol step both run the runner's container: `tcrunner`'s own uid inside (`keep-id`), a
 * read-only root with every capability dropped, and the runner's home at its host path, so a job container's mounts
 * name paths the podman service can see. The podman socket is the service's alone; the enrol step has no use for it.
 */
const RUNNER_CONTAINER_FLAGS = [
  '--userns=keep-id',
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777',
  '-e',
  'HOME=/tmp',
  '-e',
  `TC_RUNNER_HOME=${LINUX_RUNNER_HOME}`,
  `--mount=type=bind,src=${LINUX_RUNNER_HOME},dst=${LINUX_RUNNER_HOME}`,
];

/** The runner as a service: `run --loop` in its container, whose podman client talks to the socket above only. */
export function runnerUnitOf(image: string): string {
  const run = [
    '/usr/bin/podman',
    '--remote',
    'run',
    '--rm',
    '--replace',
    '--name=team-console-runner',
    ...RUNNER_CONTAINER_FLAGS,
    '-e',
    `CONTAINER_HOST=unix://${LINUX_PODMAN_SOCKET_IN_RUNNER}`,
    `--mount=type=bind,src=${LINUX_PODMAN_SOCKET},dst=${LINUX_PODMAN_SOCKET_IN_RUNNER}`,
    image,
    'run',
    '--loop',
  ];
  return [
    '[Unit]',
    'Description=Team Console runner',
    `Requires=${LINUX_PODMAN_UNIT}`,
    `After=${LINUX_PODMAN_UNIT}`,
    '',
    '[Service]',
    ...UNIT_SERVICE_BASE,
    `Environment=HOME=${LINUX_STATE_DIR} CONTAINER_HOST=unix://${LINUX_PODMAN_SOCKET}`,
    `ExecStart=${run.join(' ')}`,
    'Restart=always',
    'RestartSec=10',
    'TimeoutStopSec=90',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');
}

/** A quoted heredoc: the shell expands nothing inside, so the unit lands byte for byte. */
const unitFileOf = (unit: string, text: string): string =>
  `sudo tee ${LINUX_UNIT_DIR}/${unit} >/dev/null <<'EOF'\n${text}\nEOF`;

/**
 * Once per machine, as an admin: the `tcrunner` system user with subordinate ids of its own (rootless podman needs
 * them), both units, and podman's socket started. It neither runs the image nor carries the request id.
 */
export function linuxPrepareCommandOf(image: string): string {
  return [
    `id ${LINUX_RUNNER_USER} >/dev/null 2>&1 || sudo useradd --system --user-group --add-subids-for-system --home-dir ${LINUX_STATE_DIR} --no-create-home --shell /usr/sbin/nologin ${LINUX_RUNNER_USER}`,
    unitFileOf(LINUX_PODMAN_UNIT, podmanUnitOf()),
    unitFileOf(LINUX_RUNNER_UNIT, runnerUnitOf(image)),
    `sudo systemctl daemon-reload && sudo systemctl enable --now ${LINUX_PODMAN_UNIT}`,
  ].join('\n');
}

/**
 * The enrol step, interactive (`-it`) as `tcrunner`: the request id travels in `TC_ENROLMENT` and nothing else does.
 * There is no code and no key in it: the API key is typed at the runner's hidden prompt. The service starts once
 * `setup` succeeds.
 */
export function linuxEnrolCommandOf(origin: string, image: string, intentId: string): string {
  return [
    `sudo -u ${LINUX_RUNNER_USER} -H podman --remote --url=unix://${LINUX_PODMAN_SOCKET} run -it --rm`,
    ...RUNNER_CONTAINER_FLAGS,
    '--hostname="$(hostname)"',
    '-e',
    `${ENROLMENT_INTENT_ENV}=${intentId}`,
    image,
    `setup --url ${origin} --image ${image}`,
    `&& sudo systemctl enable --now ${LINUX_RUNNER_UNIT}`,
  ].join(' ');
}

/** The local stack's own origin: the runner accepts http for a loopback host only, and so does this. */
const LOOPBACK_HTTP_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/;

/**
 * The Linux one command for a `container` intent, or `null` when any part cannot be built from checked values. An
 * https origin everywhere; a loopback http origin on the local stack (`ENVIRONMENT=local`) as well, where the same
 * command runs against a console on this machine.
 */
export function linuxInstallCommandsOf(
  env: Pick<ApiEnv, 'ENVIRONMENT' | 'RUNNER_RELEASE_VERSION' | 'RUNNER_RELEASE_IMAGE_DIGEST'>,
  origin: string | null,
  intentId: string,
): LinuxInstallCommandsDto | null {
  const named = namedRunnerImageOf(env);
  const originOk =
    origin !== null && (HTTPS_ORIGIN.test(origin) || (env.ENVIRONMENT === 'local' && LOOPBACK_HTTP_ORIGIN.test(origin)));
  if (named === null || origin === null || !originOk || !isEnrolmentIntentId(intentId)) {
    return null;
  }
  return {
    version: named.version,
    image: named.image,
    prepare: linuxPrepareCommandOf(named.image),
    enrol: linuxEnrolCommandOf(origin, named.image, intentId),
  };
}
