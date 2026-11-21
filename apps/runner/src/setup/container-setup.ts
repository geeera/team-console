import { join } from 'node:path';
import { ENROLMENT_INTENT_ENV, LINUX_RUNNER_UNIT } from '@shared/contracts';
import { PINNED_IMAGE, apiOriginOf, configPathOf, loadRunnerConfig, updateRunnerConfig, type RunnerConfig } from '../config/config';
import { pathExists } from '../config/private-files';
import type { EnrolOptions } from '../cli/enrol';
import { CREDENTIAL_FILE_OF } from './credential';
import type { RunnerHalfReport } from './self-check';
import { SetupError } from './setup';

/**
 * `setup` inside the runner's own container on Linux (#634 PR 7, threat model C11 R-LNX): the console's enrol step runs
 * the release image interactively as `tcrunner` with `TC_ENROLMENT=<request id>`, and this enrols the home mounted at
 * `TC_RUNNER_HOME` for the `container` backend (rootless podman, the image by digest), asks for the Anthropic API key
 * at a hidden prompt, and proves the console accepts the new key. The request id is the only value that comes in
 * through the environment; no code or credential ever does. The host's systemd unit then runs `run --loop`.
 */

export interface ContainerSetupOptions {
  readonly url: string | undefined;
  /** `--enrolment`, else `TC_ENROLMENT`. */
  readonly enrolment: string | undefined;
  /** The image this container runs, by digest: every job's container is started from the same reference. */
  readonly image: string | undefined;
  readonly replaceCredential: boolean;
}

export interface ContainerSetupDeps {
  readonly home: string;
  readonly uid: number;
  readonly out: (line: string) => void;
  readonly enrol: (options: EnrolOptions) => Promise<RunnerConfig>;
  /** The hidden API-key prompt and its 0600 write (`setUpCredential` with `api-key`). */
  readonly setUpApiKey: (config: RunnerConfig, replace: boolean) => Promise<void>;
  readonly runnerHalf: () => Promise<RunnerHalfReport>;
}

/** The request id as the console's command passes it; an empty variable counts as none. */
export function enrolmentOf(flag: string | undefined, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const fromEnv = env[ENROLMENT_INTENT_ENV];
  return flag ?? (fromEnv === undefined || fromEnv === '' ? undefined : fromEnv);
}

async function enrolStep(options: ContainerSetupOptions, deps: ContainerSetupDeps): Promise<RunnerConfig> {
  if (await pathExists(configPathOf(deps.home))) {
    const config = await loadRunnerConfig(deps.home);
    const url = options.url === undefined ? null : apiOriginOf(options.url);
    if (url !== null && config.apiUrl !== url) {
      throw new SetupError(
        `this runner is enrolled with ${config.apiUrl}, not ${url}: revoke it on Settings › Runners and empty ${deps.home} to enrol it again`,
      );
    }
    if (config.backend !== 'container') {
      throw new SetupError(`${deps.home} holds a ${config.backend} runner; the Linux setup enrols the container backend only`);
    }
    deps.out(`enrol: already enrolled as «${config.name}»${options.enrolment === undefined ? '' : `; ${ENROLMENT_INTENT_ENV} is not used`}`);
    return config;
  }
  if (options.url === undefined || options.enrolment === undefined) {
    throw new SetupError(
      `enrol: a new runner needs --url <console origin> and ${ENROLMENT_INTENT_ENV}=<request id> from Settings › Runners › Add runner`,
    );
  }
  return await deps.enrol({
    url: options.url,
    enrolment: options.enrolment,
    backend: 'container',
    credential: 'api-key',
    image: options.image,
  });
}

/** Runs enrol, the API key and the console check in order; stops at the first that fails with the line to act on. */
export async function runContainerSetup(options: ContainerSetupOptions, deps: ContainerSetupDeps): Promise<boolean> {
  if (deps.uid === 0) {
    throw new SetupError('the Linux setup runs as the runner’s own user in its container (tcrunner), never as root');
  }
  if (options.url !== undefined && apiOriginOf(options.url) === null) {
    throw new SetupError('--url must be the console origin, https://… (http only for a loopback host)');
  }
  if (options.image === undefined || !PINNED_IMAGE.test(options.image)) {
    throw new SetupError('--image must be the runner image the console named, pinned by digest (<name>@sha256:…)');
  }
  const image = options.image;
  const enrolled = await enrolStep(options, deps);
  if (enrolled.container !== undefined && enrolled.container.image !== image) {
    // A new release's command: jobs follow the image the service now runs, by its digest.
    deps.out(`config: jobs now run from ${image} (was ${enrolled.container.image})`);
  }
  // Jobs start through tcrunner's rootless podman, so their mounts and uid map onto the host as the runner's own.
  const config =
    enrolled.container?.image === image && enrolled.container.runtime === 'podman'
      ? enrolled
      : await updateRunnerConfig(deps.home, (current) => ({ ...current, container: { ...current.container, image, runtime: 'podman' } }));

  const file = CREDENTIAL_FILE_OF['api-key'];
  if (!options.replaceCredential && (await pathExists(join(deps.home, file)))) {
    deps.out(`credential: ${file} is present and kept (--replace-credential to replace it)`);
  } else {
    await deps.setUpApiKey(config, options.replaceCredential);
  }

  const report = await deps.runnerHalf();
  if (report.failure !== null) {
    deps.out(`check: ${report.failure.stage}: ${report.failure.message}`);
    return false;
  }
  if (report.self?.belowMinimum === true) {
    deps.out('check: this image is below the console’s minimum version; take the new command from Settings › Runners');
    return false;
  }
  deps.out(`Готово: раннер «${config.name}» принят консолью; ${LINUX_RUNNER_UNIT} запускается следующей командой.`);
  return true;
}
