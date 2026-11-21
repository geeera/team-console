import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The release launcher `bin/team-console-runner` (#778, S2 of the #634 security note), run for real by /bin/sh. As
 * root it runs only the release's own `<prefix>/node` (#634 PR 5), and only when root alone can change it: the file and
 * every directory up to `/`, links resolved, and it execs the checked physical path. `/usr/bin/id` and `/usr/bin/stat` are swapped for fakes in a copy of the script, so
 * the spec plays root and decides which paths count as root-owned without needing root itself.
 */

const app = join(import.meta.dirname, '..');
const launcherText = readFileSync(join(app, 'bin', 'team-console-runner'), 'utf8');

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

describe('bin/team-console-runner', () => {
  let root: string;
  let prefix: string;
  let userBin: string;
  /** `uid mode path` lines the fake stat answers; any other path gets the real stat. */
  let table: string[];

  const exe = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, 0o755);
  };
  /** A node that prints the path it was run by and its arguments, one per line. */
  const fakeNode = (path: string): void => exe(path, '#!/bin/sh\nprintf \'%s\\n\' "$0" "$@"\n');
  const rootOwned = (path: string, mode = '755'): void => {
    table.push(`0 ${mode} ${path}`);
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'launcher-')));
    prefix = join(root, 'prefix');
    userBin = join(root, 'home', 'bin');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    mkdirSync(userBin, { recursive: true });
    writeFileSync(join(prefix, 'team-console-runner.mjs'), '');
    table = [];
    // Everything above the temp directory is root's, as on a real host (on CI, /tmp itself is 1777).
    for (let dir = dirname(root); ; dir = dirname(dir)) {
      rootOwned(dir);
      if (dir === '/') {
        break;
      }
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (uid: number): Run => {
    const tableFile = join(root, 'stat-table');
    writeFileSync(tableFile, `${table.join('\n')}\n`);
    exe(join(root, 'fakes', 'id'), `#!/bin/sh\necho ${String(uid)}\n`);
    exe(
      join(root, 'fakes', 'stat'),
      [
        '#!/bin/sh',
        'for p; do :; done',
        `while IFS=' ' read -r uid mode path; do`,
        '  if [ "$path" = "$p" ]; then echo "$uid $mode"; exit 0; fi',
        `done < '${tableFile}'`,
        'exec /usr/bin/stat "$@"',
        '',
      ].join('\n'),
    );
    // Only these tools are on PATH, so `command -v node` never finds the developer's or the CI image's own node.
    const tools = join(root, 'tools');
    mkdirSync(tools, { recursive: true });
    for (const tool of ['dirname', 'basename', 'readlink']) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(found, join(tools, tool));
    }
    const launcher = join(prefix, 'bin', 'team-console-runner');
    writeFileSync(
      launcher,
      launcherText
        .replaceAll('/usr/bin/id', join(root, 'fakes', 'id'))
        .replaceAll('/usr/bin/stat -', `${join(root, 'fakes', 'stat')} -`)
        // Homebrew's fallbacks point into the temp directory, where no spec puts a node unless it says so.
        .replace('/opt/homebrew/bin/node /usr/local/bin/node', `${join(root, 'brew', 'node')} ${join(root, 'local', 'node')}`),
    );
    chmodSync(launcher, 0o755);
    const result = spawnSync('/bin/sh', [launcher, 'version'], {
      encoding: 'utf8',
      env: { PATH: `${userBin}:${tools}` },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  const argsOf = (result: Run): string[] => result.stdout.split('\n').filter((line) => line !== '');
  /** Refused with the fix, and no node ran (the fake one would have printed). */
  const expectRefused = (result: Run): void => {
    expect(result.status).toBe(126);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("as root only the release's own node runs");
  };

  it('as a user, runs the node on PATH with SIGUSR1 off', () => {
    fakeNode(join(userBin, 'node'));
    const result = run(501);
    expect(result.status).toBe(0);
    expect(argsOf(result)).toEqual([
      join(userBin, 'node'),
      '--disable-sigusr1',
      join(prefix, 'team-console-runner.mjs'),
      'version',
    ]);
  });

  it('prefers the node the release ships next to the bundle', () => {
    fakeNode(join(userBin, 'node'));
    fakeNode(join(prefix, 'node'));
    expect(argsOf(run(501))[0]).toBe(join(prefix, 'node'));
  });

  it('as root, refuses a node the login user owns and never falls back to one', () => {
    fakeNode(join(userBin, 'node'));
    const result = run(0);
    expectRefused(result);
    expect(result.stderr).toContain(join(prefix, 'node'));
    expect(result.stderr).toContain('docs/runbooks/runner.md');
  });

  it('as root, never falls back to another node, even one root alone can change', () => {
    for (const node of [join(root, 'brew', 'node'), join(root, 'local', 'node')]) {
      fakeNode(node);
      rootOwned(node, '555');
      rootOwned(dirname(node));
    }
    rootOwned(root);
    expectRefused(run(0));
  });

  it('as root, refuses a root-owned node in a directory that is not root-owned', () => {
    const node = join(prefix, 'node');
    fakeNode(node);
    rootOwned(node, '555');
    // `prefix` and `root` stay the developer's: whoever owns them can swap the file.
    expectRefused(run(0));
  });

  it.each(['775', '757'])('as root, refuses a node under a root-owned directory with mode %s', (mode) => {
    const node = join(prefix, 'node');
    fakeNode(node);
    rootOwned(node, '555');
    rootOwned(prefix, mode);
    rootOwned(root);
    expectRefused(run(0));
  });

  it('as root, runs a node that root alone can change, with SIGUSR1 off', () => {
    const node = join(prefix, 'node');
    fakeNode(node);
    rootOwned(node, '555');
    rootOwned(prefix);
    rootOwned(root);
    const result = run(0);
    expect(result.status).toBe(0);
    expect(argsOf(result)).toEqual([node, '--disable-sigusr1', join(prefix, 'team-console-runner.mjs'), 'version']);
  });

  it('as root, follows the prefix link through current and execs the checked target, not the link', () => {
    // The layout `update` leaves: <prefix>/node -> current/node, current -> releases/<version>.
    const target = join(prefix, 'releases', '0.2.0', 'node');
    fakeNode(target);
    symlinkSync(join('releases', '0.2.0'), join(prefix, 'current'));
    symlinkSync(join('current', 'node'), join(prefix, 'node'));
    rootOwned(target, '555');
    rootOwned(dirname(target));
    rootOwned(join(prefix, 'releases'));
    rootOwned(prefix);
    rootOwned(root);
    const result = run(0);
    expect(result.status).toBe(0);
    expect(argsOf(result)[0]).toBe(target);
  });

  it('as root, refuses a prefix link whose target is not root-owned', () => {
    const target = join(root, 'cellar', 'node');
    fakeNode(target);
    rootOwned(prefix);
    rootOwned(root);
    symlinkSync(target, join(prefix, 'node'));
    expectRefused(run(0));
  });
});
