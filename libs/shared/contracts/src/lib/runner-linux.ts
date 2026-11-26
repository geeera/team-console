import { compareRunnerVersions } from './runner';
import { RELEASE_REPOSITORY } from './runner-release';

/**
 * The Linux one command (#634 PR 7, threat model C11 R-LNX): the runner runs as a container of the release image,
 * pinned by digest, under rootless podman of a dedicated system user, and starts each job's container through that
 * user's own podman socket. Every name here is a compile-time constant shared by the console's command builder, the
 * runner's `setup` and the runbook, so none of them comes from a request, a config file or a console answer.
 */

/** The image `release-runner.yml` publishes and signs. A reference to it always carries the digest. */
export const RUNNER_IMAGE = `ghcr.io/${RELEASE_REPOSITORY}-runner`;

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
export const isImageDigest = (value: unknown): value is string =>
  typeof value === 'string' && IMAGE_DIGEST.test(value);

/** `ghcr.io/geeera/team-console-runner:<version>@sha256:<digest>`: the tag is a label, the digest is what is pulled. */
export const runnerImageRefOf = (version: string, digest: string): string =>
  `${RUNNER_IMAGE}:${version}@${digest}`;

/**
 * The first release whose image holds the podman client and the container `setup` (#634 PR 7). The console offers
 * the Linux command only from this version on; an older image cannot run it.
 */
export const LINUX_SETUP_SINCE = '0.2.0';

export function isLinuxSetupShipped(version: string): boolean {
  const order = compareRunnerVersions(version, LINUX_SETUP_SINCE);
  return order !== null && order >= 0;
}

/** The environment variable the Linux `setup` reads the enrolment request's id from: an identifier, never a secret. */
export const ENROLMENT_INTENT_ENV = 'TC_ENROLMENT';

/** The host's system user that owns rootless podman, its storage and the runner's home. Never root, no login shell. */
export const LINUX_RUNNER_USER = 'tcrunner';
/** That user's home and systemd `StateDirectory`: outside `/home`, so `ProtectHome=yes` hides every login user's home. */
export const LINUX_STATE_DIR = '/var/lib/team-console-runner';
/** `TC_RUNNER_HOME`, mounted at the same path inside the runner's container so a job's mounts name host paths. */
export const LINUX_RUNNER_HOME = `${LINUX_STATE_DIR}/home`;
/** Rootless podman's API socket of `tcrunner`: the only runtime socket the runner's container gets (R-LNX). */
export const LINUX_PODMAN_SOCKET = `${LINUX_STATE_DIR}/podman.sock`;
/** Where that socket appears inside the runner's container. */
export const LINUX_PODMAN_SOCKET_IN_RUNNER = '/run/team-console-runner/podman.sock';
export const LINUX_RUNNER_UNIT = 'team-console-runner.service';
export const LINUX_PODMAN_UNIT = 'team-console-runner-podman.service';
export const LINUX_UNIT_DIR = '/etc/systemd/system';
