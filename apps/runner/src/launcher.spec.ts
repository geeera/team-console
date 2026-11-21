import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The release launcher `bin/team-console-runner` (#778, S2 of the #634 security note), run for real by /bin/sh. As
 * root it runs only the release's own `<prefix>/node` (#634 PR 5), and only when root alone can change it: the file and
 * every directory up to `/`, links resolved, and it execs the checked physical path; the same for the bundle (#884), with
 * no macOS ACL entry that lets anyone else write and no `NODE_*` variable left. `/usr/bin/id`, `/usr/bin/stat`,
 * `/usr/bin/uname` and `/bin/ls` are swapped for fakes in a copy of the script, so the spec plays root on either OS and
 * decides which paths count as root-owned and which carry an ACL without needing root itself.
 */

const app = join(import.meta.dirname, '..');
const launcherText = readFileSync(join(app, 'bin', 'team-console-runner'), 'utf8');

interface RunOptions {
  /** What `uname -s` answers: `Darwin` turns the ACL check on. Defaults to the host's. */
  readonly os?: 'Darwin' | 'Linux';
  readonly env?: Readonly<Record<string, string>>;
}

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
  /** `path<TAB>ace` lines the fake `ls -lde` lists under that path. */
  let acls: string[];

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
  const acl = (path: string, ace: string): void => {
    acls.push(`${path}\t${ace}`);
  };
  const bundle = (): string => join(prefix, 'team-console-runner.mjs');

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'launcher-')));
    prefix = join(root, 'prefix');
    userBin = join(root, 'home', 'bin');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    mkdirSync(userBin, { recursive: true });
    writeFileSync(join(prefix, 'team-console-runner.mjs'), '');
    table = [];
    acls = [];
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

  const run = (uid: number, options: RunOptions = {}): Run => {
    const tableFile = join(root, 'stat-table');
    writeFileSync(tableFile, `${table.join('\n')}\n`);
    const aclFile = join(root, 'acl-table');
    writeFileSync(aclFile, `${acls.join('\n')}\n`);
    exe(join(root, 'fakes', 'id'), `#!/bin/sh\necho ${String(uid)}\n`);
    const os = options.os ?? (process.platform === 'darwin' ? 'Darwin' : 'Linux');
    exe(join(root, 'fakes', 'uname'), `#!/bin/sh\necho ${os}\n`);
    exe(
      join(root, 'fakes', 'ls'),
      [
        '#!/bin/sh',
        'for p; do :; done',
        'echo "drwxr-xr-x  2 root  wheel  64 Nov 22 00:00 $p"',
        "tab=$(printf '\\t')",
        `while IFS="$tab" read -r path ace; do`,
        '  if [ "$path" = "$p" ]; then echo "$ace"; fi',
        `done < '${aclFile}'`,
        '',
      ].join('\n'),
    );
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
        .replaceAll('/usr/bin/uname', join(root, 'fakes', 'uname'))
        .replaceAll('/bin/ls -lde', `${join(root, 'fakes', 'ls')} -lde`)
        .replaceAll('/usr/bin/stat -', `${join(root, 'fakes', 'stat')} -`)
        // Homebrew's fallbacks point into the temp directory, where no spec puts a node unless it says so.
        .replace('/opt/homebrew/bin/node /usr/local/bin/node', `${join(root, 'brew', 'node')} ${join(root, 'local', 'node')}`),
    );
    chmodSync(launcher, 0o755);
    const result = spawnSync('/bin/sh', [launcher, 'version'], {
      encoding: 'utf8',
      env: { ...options.env, PATH: `${userBin}:${tools}` },
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

  /** A flat release root alone can change: `<prefix>/node`, the bundle, the prefix and everything above. */
  const rootOnlyRelease = (): string => {
    const node = join(prefix, 'node');
    fakeNode(node);
    rootOwned(node, '555');
    rootOwned(bundle(), '444');
    rootOwned(prefix);
    rootOwned(root);
    return node;
  };

  it('as root, runs a node that root alone can change, with SIGUSR1 off', () => {
    const node = rootOnlyRelease();
    const result = run(0);
    expect(result.status).toBe(0);
    expect(argsOf(result)).toEqual([node, '--disable-sigusr1', bundle(), 'version']);
  });

  it('as root, follows the prefix links through current and execs the checked targets, not the links', () => {
    // The layout `update` leaves: <prefix>/node -> current/node, current -> releases/<version>, the bundle likewise.
    const release = join(prefix, 'releases', '0.2.0');
    const target = join(release, 'node');
    fakeNode(target);
    writeFileSync(join(release, 'team-console-runner.mjs'), '');
    symlinkSync(join('releases', '0.2.0'), join(prefix, 'current'));
    symlinkSync(join('current', 'node'), join(prefix, 'node'));
    rmSync(bundle());
    symlinkSync(join('current', 'team-console-runner.mjs'), bundle());
    rootOwned(target, '555');
    rootOwned(join(release, 'team-console-runner.mjs'), '444');
    rootOwned(release);
    rootOwned(join(prefix, 'releases'));
    rootOwned(prefix);
    rootOwned(root);
    const result = run(0);
    expect(result.status).toBe(0);
    expect(argsOf(result)).toEqual([target, '--disable-sigusr1', join(release, 'team-console-runner.mjs'), 'version']);
  });

  it.each([
    ['the login user owns', '501 444'],
    ['the group can write', '0 664'],
  ])('as root, refuses a bundle %s', (_, facts) => {
    rootOnlyRelease();
    table.unshift(`${facts} ${bundle()}`);
    const result = run(0);
    expectRefused(result);
    expect(result.stderr).toContain(bundle());
  });

  it('as root, refuses a bundle link whose target is not root-owned', () => {
    rootOnlyRelease();
    const target = join(root, 'home', 'team-console-runner.mjs');
    writeFileSync(target, '');
    rmSync(bundle());
    symlinkSync(target, bundle());
    expectRefused(run(0));
  });

  it('as root, walks the directories with its own tools, whatever dirname the PATH offers', () => {
    const node = join(prefix, 'node');
    // Honest while links are resolved (the first ask for the node or the bundle), then straight to `/` for the
    // ownership walk, skipping every directory the login user owns.
    const realDirname = spawnSync('/bin/sh', ['-c', 'command -v dirname'], { encoding: 'utf8' }).stdout.trim();
    exe(
      join(userBin, 'dirname'),
      [
        '#!/bin/sh',
        'case $2 in',
        `  '${prefix}') echo /; exit 0 ;;`,
        `  '${node}') seen='${join(root, 'seen-node')}' ;;`,
        `  '${bundle()}') seen='${join(root, 'seen-bundle')}' ;;`,
        `  *) exec '${realDirname}' "$@" ;;`,
        'esac',
        'if [ -e "$seen" ]; then echo /; exit 0; fi',
        ': > "$seen"',
        `exec '${realDirname}' "$@"`,
        '',
      ].join('\n'),
    );
    fakeNode(node);
    rootOwned(node, '555');
    rootOwned(bundle(), '444');
    rootOwned(prefix);
    // `root`, the prefix's parent, stays the developer's: they could rename the prefix away and plant their own.
    expectRefused(run(0));
  });

  it('as root, refuses a missing bundle', () => {
    rootOnlyRelease();
    rmSync(bundle());
    expectRefused(run(0));
  });

  describe('as root on macOS, ACLs', () => {
    it.each([
      ['the prefix', (): string => prefix, 'user:kirill allow add_file,delete_child'],
      ['the bundle', bundle, 'user:kirill allow write,append'],
      ['the node', (): string => join(prefix, 'node'), 'group:staff inherited allow writeattr,writeextattr'],
      ['a directory above', (): string => root, 'group:everyone allow chown'],
    ])('refuses an entry on %s that lets someone else write', (_, pathOf, ace) => {
      rootOnlyRelease();
      acl(pathOf(), ` 0: ${ace}`);
      const result = run(0, { os: 'Darwin' });
      expectRefused(result);
      expect(result.stderr).toContain('ACL');
    });

    it('runs with entries that only deny, only read, or grant root', () => {
      const node = rootOnlyRelease();
      acl(prefix, ' 0: group:everyone deny delete');
      acl(prefix, ' 1: user:kirill allow list,search,readattr');
      acl(bundle(), ' 0: user:root allow write,append');
      const result = run(0, { os: 'Darwin' });
      expect(result.status).toBe(0);
      expect(argsOf(result)[0]).toBe(node);
    });

    it('ignores ACLs on Linux, which has none of them', () => {
      rootOnlyRelease();
      acl(prefix, ' 0: user:kirill allow write');
      expect(run(0, { os: 'Linux' }).status).toBe(0);
    });
  });

  it('as root, drops every NODE_* variable before the exec and keeps the rest', () => {
    const node = rootOnlyRelease();
    exe(
      node,
      '#!/bin/sh\nprintf \'%s\\n\' "${NODE_OPTIONS-unset}" "${NODE_PATH-unset}" "${NODE_TLS_REJECT_UNAUTHORIZED-unset}" "${TC_KEEP-unset}"\n',
    );
    const result = run(0, {
      env: {
        NODE_OPTIONS: `--require ${join(root, 'home', 'evil.js')}`,
        NODE_PATH: join(root, 'home'),
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        TC_KEEP: 'kept',
      },
    });
    expect(result.status).toBe(0);
    expect(argsOf(result)).toEqual(['unset', 'unset', 'unset', 'kept']);
  });

  it('as a user, leaves NODE_OPTIONS to the user', () => {
    exe(join(userBin, 'node'), '#!/bin/sh\nprintf \'%s\\n\' "${NODE_OPTIONS-unset}"\n');
    expect(argsOf(run(501, { env: { NODE_OPTIONS: '--trace-warnings' } }))).toEqual(['--trace-warnings']);
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
