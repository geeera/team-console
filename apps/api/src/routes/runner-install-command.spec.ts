import { tarballUrlOf } from '@shared/contracts';
import {
  linuxEnrolCommandOf,
  linuxInstallCommandsOf,
  linuxPrepareCommandOf,
  macInstallCommandOf,
  macInstallCommandsOf,
  namedRunnerImageOf,
  namedRunnerReleaseOf,
  podmanUnitOf,
  runnerUnitOf,
  type MacInstallCommandInput,
} from './runner-install-command';

/**
 * The macOS first-install one-liner (#634 PR 5; threat model C11 R-ONE-1, R-ONE-2): built from compile-time constants
 * and strictly shaped values only, never from a request, and `null` for anything that could change what a pasted line
 * does in a shell.
 */

const INTENT = '01JD0000000000000000000000';
const SUM = 'a'.repeat(64);
const input: MacInstallCommandInput = {
  origin: 'https://console.example',
  version: '0.2.0',
  platform: 'darwin-arm64',
  sha256: SUM,
  intentId: INTENT,
};
const sumsOf = (version: string): string =>
  ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
    .map((platform, index) => `${String(index + 1).repeat(64)}  team-console-runner-${version}-${platform}.tar.gz\n`)
    .join('');

describe('macInstallCommandOf', () => {
  it('downloads the pinned repository’s asset over https only, checks it, then runs setup as root from a root copy', () => {
    const command = macInstallCommandOf(input) ?? '';
    expect(command).toBe(
      [
        'd=$(mktemp -d)',
        `curl --proto '=https' --tlsv1.2 -fsSLo "$d/tcr.tgz" https://github.com/geeera/team-console/releases/download/v0.2.0/team-console-runner-0.2.0-darwin-arm64.tar.gz`,
        `echo "${SUM}  $d/tcr.tgz" | shasum -a 256 -c -`,
        `sudo /bin/sh -c 's=$(/usr/bin/mktemp -d /var/root/tcr.XXXXXX) && /bin/cp "$1" "$s/tcr.tgz" && echo "${SUM}  $s/tcr.tgz" | /usr/bin/shasum -a 256 -c - && /usr/bin/tar -xzf "$s/tcr.tgz" -C "$s" && { "$s/bin/team-console-runner" setup --url https://console.example --enrolment ${INTENT} --release "$s/tcr.tgz" --sha256 ${SUM}; r=$?; /bin/rm -rf "$s"; exit $r; }' sh "$d/tcr.tgz"`,
      ].join(' && '),
    );
    expect(command).toContain(tarballUrlOf('0.2.0', 'darwin-arm64'));
    // The sum is checked before sudo is asked for, and extraction comes only after the root copy matched it again.
    expect(command.indexOf('shasum')).toBeLessThan(command.indexOf('sudo'));
    expect(command.lastIndexOf('shasum')).toBeLessThan(command.indexOf('tar -xzf'));
    expect(command).not.toMatch(/\| *(sh|bash)\b/);
    expect(command).not.toContain('\n');
  });

  it.each([
    ['an http origin', { origin: 'http://console.example' }],
    ['an origin with a path', { origin: 'https://console.example/x' }],
    ['an origin with a quote', { origin: "https://console.example'" }],
    ['an origin with a command', { origin: 'https://x.example;id' }],
    ['a version with a build label', { version: '0.2.0+evil' }],
    ['a version with a space', { version: '0.2.0 --x' }],
    ['a release before the bundled node', { version: '0.1.9' }],
    ['a Linux platform', { platform: 'linux-x64' as MacInstallCommandInput['platform'] }],
    ['a short sum', { sha256: 'a'.repeat(63) }],
    ['an uppercase sum', { sha256: 'A'.repeat(64) }],
    ['an intent that is no ULID', { intentId: '$(id)' }],
  ])('builds nothing for %s', (_, overrides) => {
    expect(macInstallCommandOf({ ...input, ...overrides })).toBeNull();
  });
});

describe('namedRunnerReleaseOf (the Worker’s format check, R-ONE-2)', () => {
  it('takes exactly the release’s SHA256SUMS text and maps each platform to its sum', () => {
    expect(namedRunnerReleaseOf({ RUNNER_RELEASE_VERSION: '0.2.0', RUNNER_RELEASE_SHA256SUMS: sumsOf('0.2.0') })).toEqual({
      version: '0.2.0',
      sums: {
        'darwin-arm64': '1'.repeat(64),
        'darwin-x64': '2'.repeat(64),
        'linux-arm64': '3'.repeat(64),
        'linux-x64': '4'.repeat(64),
      },
    });
  });

  it.each([
    ['no version', { RUNNER_RELEASE_SHA256SUMS: sumsOf('0.2.0') }],
    ['no sums', { RUNNER_RELEASE_VERSION: '0.2.0' }],
    ['sums of another version', { RUNNER_RELEASE_VERSION: '0.2.0', RUNNER_RELEASE_SHA256SUMS: sumsOf('0.3.0') }],
    ['an extra line', { RUNNER_RELEASE_VERSION: '0.2.0', RUNNER_RELEASE_SHA256SUMS: `${sumsOf('0.2.0')}${'5'.repeat(64)}  x.tar.gz\n` }],
    ['a missing newline', { RUNNER_RELEASE_VERSION: '0.2.0', RUNNER_RELEASE_SHA256SUMS: sumsOf('0.2.0').slice(0, -1) }],
    ['a single space', { RUNNER_RELEASE_VERSION: '0.2.0', RUNNER_RELEASE_SHA256SUMS: sumsOf('0.2.0').replace('  ', ' ') }],
    ['a release without node', { RUNNER_RELEASE_VERSION: '0.1.0', RUNNER_RELEASE_SHA256SUMS: sumsOf('0.1.0') }],
  ])('refuses %s', (_, env) => {
    expect(namedRunnerReleaseOf(env)).toBeNull();
  });
});

describe('macInstallCommandsOf', () => {
  const env = { RUNNER_RELEASE_VERSION: '0.2.0', RUNNER_RELEASE_SHA256SUMS: sumsOf('0.2.0') };

  it('gives each Mac processor its own tarball and sum', () => {
    const commands = macInstallCommandsOf(env, 'https://console.example', INTENT);
    expect(commands?.version).toBe('0.2.0');
    expect(commands?.['darwin-arm64']).toContain(`-darwin-arm64.tar.gz`);
    expect(commands?.['darwin-arm64']).toContain(`--sha256 ${'1'.repeat(64)}`);
    expect(commands?.['darwin-x64']).toContain(`-darwin-x64.tar.gz`);
    expect(commands?.['darwin-x64']).toContain(`--sha256 ${'2'.repeat(64)}`);
  });

  it('gives nothing without a configured origin or a named release', () => {
    expect(macInstallCommandsOf(env, null, INTENT)).toBeNull();
    expect(macInstallCommandsOf({}, 'https://console.example', INTENT)).toBeNull();
  });
});

/**
 * The Linux one command (#634 PR 7, threat model C11 R-LNX): the image by digest only, no Docker socket, the runner
 * under a dedicated non-root user with the systemd hardening, and the request id as the only value passed with `-e`.
 */
describe('the Linux one command', () => {
  const DIGEST = `sha256:${'d'.repeat(64)}`;
  const IMAGE = `ghcr.io/geeera/team-console-runner:0.2.0@${DIGEST}`;
  const env = { RUNNER_RELEASE_VERSION: '0.2.0', RUNNER_RELEASE_IMAGE_DIGEST: DIGEST };
  const unitLines = (unit: string): string[] => unit.split('\n');
  const execStartOf = (unit: string): string => unitLines(unit).find((line) => line.startsWith('ExecStart=')) ?? '';

  it('names the image of the configured release by its digest', () => {
    expect(namedRunnerImageOf(env)).toEqual({ version: '0.2.0', image: IMAGE });
  });

  it.each([
    ['no digest', { RUNNER_RELEASE_VERSION: '0.2.0' }],
    ['no version', { RUNNER_RELEASE_IMAGE_DIGEST: DIGEST }],
    ['a release before the Linux setup', { ...env, RUNNER_RELEASE_VERSION: '0.1.0' }],
    ['a tag in place of a digest', { ...env, RUNNER_RELEASE_IMAGE_DIGEST: '0.2.0' }],
    ['a short digest', { ...env, RUNNER_RELEASE_IMAGE_DIGEST: `sha256:${'d'.repeat(63)}` }],
    ['an upper-case digest', { ...env, RUNNER_RELEASE_IMAGE_DIGEST: `sha256:${'D'.repeat(64)}` }],
    ['a digest with a shell tail', { ...env, RUNNER_RELEASE_IMAGE_DIGEST: `${DIGEST};id` }],
  ])('names no image with %s', (_, vars) => {
    expect(namedRunnerImageOf(vars)).toBeNull();
  });

  it('runs both units as tcrunner with NoNewPrivileges, ProtectSystem=strict and ProtectHome=yes', () => {
    for (const unit of [podmanUnitOf(), runnerUnitOf(IMAGE)]) {
      const lines = unitLines(unit);
      expect(lines).toEqual(
        expect.arrayContaining([
          'User=tcrunner',
          'Group=tcrunner',
          'NoNewPrivileges=yes',
          'ProtectSystem=strict',
          'ProtectHome=yes',
          'PrivateTmp=yes',
          'StateDirectory=team-console-runner',
          'StateDirectoryMode=0700',
        ]),
      );
      expect(lines.filter((line) => /^(User|ProtectSystem|ProtectHome|NoNewPrivileges)=/.test(line))).toHaveLength(4);
      // Nothing runs with more than the user's rights: no root, no capability, no `+`/`!` privileged Exec line.
      expect(unit).not.toMatch(/User=root|AmbientCapabilities|CapabilityBoundingSet|PermissionsStartOnly|^Exec\w*=[+!]/m);
    }
  });

  it('serves rootless podman of tcrunner on a socket in its own state directory', () => {
    expect(execStartOf(podmanUnitOf())).toBe(
      'ExecStart=/usr/bin/podman system service --time=0 unix:///var/lib/team-console-runner/podman.sock',
    );
  });

  it('caps the jobs together at the podman unit, where rootless podman cannot cap each one', () => {
    expect(unitLines(podmanUnitOf())).toEqual(expect.arrayContaining(['TasksMax=4096', 'MemoryMax=6G']));
  });

  it('runs the runner by digest with that socket only, never a docker.sock', () => {
    const unit = runnerUnitOf(IMAGE);
    expect(execStartOf(unit)).toBe(
      `ExecStart=/usr/bin/podman --remote run --rm --replace --name=team-console-runner --userns=keep-id --read-only --cap-drop=ALL --security-opt=no-new-privileges --tmpfs=/tmp:rw,nosuid,nodev,mode=1777 -e HOME=/tmp -e TC_RUNNER_HOME=/var/lib/team-console-runner/home --mount=type=bind,src=/var/lib/team-console-runner/home,dst=/var/lib/team-console-runner/home -e CONTAINER_HOST=unix:///run/team-console-runner/podman.sock --mount=type=bind,src=/var/lib/team-console-runner/podman.sock,dst=/run/team-console-runner/podman.sock ${IMAGE} run --loop`,
    );
    expect(unit).toContain('Requires=team-console-runner-podman.service');
    expect(unit).not.toMatch(/docker\.sock|--privileged/);
  });

  it('prepares the host without running the image or naming the request', () => {
    const prepare = linuxPrepareCommandOf(IMAGE);
    expect(prepare.split('\n')[0]).toBe(
      'id tcrunner >/dev/null 2>&1 || sudo useradd --system --user-group --add-subids-for-system --home-dir /var/lib/team-console-runner --no-create-home --shell /usr/sbin/nologin tcrunner',
    );
    // Quoted heredocs: the shell expands nothing inside a unit.
    expect(prepare).toContain(`sudo tee /etc/systemd/system/team-console-runner-podman.service >/dev/null <<'EOF'\n${podmanUnitOf()}\nEOF`);
    expect(prepare).toContain(`sudo tee /etc/systemd/system/team-console-runner.service >/dev/null <<'EOF'\n${runnerUnitOf(IMAGE)}\nEOF`);
    expect(prepare.endsWith('sudo systemctl daemon-reload && sudo systemctl enable --now team-console-runner-podman.service')).toBe(true);
    expect(prepare).not.toMatch(/TC_ENROLMENT|docker\.sock/);
  });

  it('enrols interactively as tcrunner with the request id as the only value passed in', () => {
    const enrol = linuxEnrolCommandOf('https://console.example', IMAGE, INTENT);
    expect(enrol).toBe(
      `sudo -u tcrunner -H podman --remote --url=unix:///var/lib/team-console-runner/podman.sock run -it --rm --userns=keep-id --read-only --cap-drop=ALL --security-opt=no-new-privileges --tmpfs=/tmp:rw,nosuid,nodev,mode=1777 -e HOME=/tmp -e TC_RUNNER_HOME=/var/lib/team-console-runner/home --mount=type=bind,src=/var/lib/team-console-runner/home,dst=/var/lib/team-console-runner/home --hostname="$(hostname)" -e TC_ENROLMENT=${INTENT} ${IMAGE} setup --url https://console.example --image ${IMAGE} && sudo systemctl enable team-console-runner.service && sudo systemctl restart team-console-runner.service`,
    );
    expect(enrol).not.toContain('\n');
    const passed = [...enrol.matchAll(/-e (\S+?)=/g)].map((match) => match[1]);
    expect(passed).toEqual(['HOME', 'TC_RUNNER_HOME', 'TC_ENROLMENT']);
    expect(enrol).not.toMatch(/tce_|sk-ant|API_KEY|TC_ENROL_CODE|--env-file|docker\.sock/);
  });

  it.each([
    ['the console names no origin', null, INTENT],
    ['an http origin', 'http://console.example', INTENT],
    ['an origin with a shell tail', 'https://console.example;id', INTENT],
    ['an id that is not a ULID', 'https://console.example', 'x'],
  ])('builds nothing when %s', (_, origin, intent) => {
    expect(linuxInstallCommandsOf(env, origin, intent)).toBeNull();
  });

  it('takes a loopback http origin on the local stack only, as the runner does', () => {
    const local = { ...env, ENVIRONMENT: 'local' };
    expect(linuxInstallCommandsOf(local, 'http://127.0.0.1:8300', INTENT)?.enrol).toContain('setup --url http://127.0.0.1:8300 ');
    expect(linuxInstallCommandsOf(local, 'http://console.example', INTENT)).toBeNull();
    expect(linuxInstallCommandsOf({ ...env, ENVIRONMENT: 'dev' }, 'http://127.0.0.1:8300', INTENT)).toBeNull();
  });

  it('builds the pair from the named image only', () => {
    expect(linuxInstallCommandsOf(env, 'https://console.example', INTENT)).toEqual({
      version: '0.2.0',
      image: IMAGE,
      prepare: linuxPrepareCommandOf(IMAGE),
      enrol: linuxEnrolCommandOf('https://console.example', IMAGE, INTENT),
    });
    expect(linuxInstallCommandsOf({}, 'https://console.example', INTENT)).toBeNull();
  });
});
