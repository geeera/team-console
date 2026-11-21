import { tarballUrlOf } from '@shared/contracts';
import { macInstallCommandOf, macInstallCommandsOf, namedRunnerReleaseOf, type MacInstallCommandInput } from './runner-install-command';

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
