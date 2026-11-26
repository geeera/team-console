import type { PathFacts } from '../install/install';
import { candidatesOf, detectToolchain, jobPathOf, type ToolchainHost } from './toolchain';

const OWNER_UID = 501;

interface FakeEntry {
  readonly facts: PathFacts;
  readonly target?: string;
}

/** A file tree with owners and modes, links and which binaries `_tcjob` can run. */
function fakeHost(entries: Record<string, FakeEntry>, runnable: readonly string[]) {
  const probes: string[][] = [];
  const dir = (uid = 0, mode = 0o755): FakeEntry => ({ facts: { uid, mode, kind: 'directory' } });
  const tree: Record<string, FakeEntry> = {
    '/': dir(),
    '/usr': dir(),
    '/usr/bin': dir(),
    '/usr/local': dir(),
    '/usr/local/bin': dir(),
    '/opt': dir(),
    '/opt/homebrew': dir(OWNER_UID),
    '/opt/homebrew/bin': dir(OWNER_UID),
    '/Users': dir(),
    '/Users/owner': dir(OWNER_UID, 0o750),
    '/Users/owner/.local': dir(OWNER_UID),
    '/Users/owner/.local/bin': dir(OWNER_UID),
    '/tmp': dir(0, 0o1777),
    ...entries,
  };
  const host: ToolchainHost = {
    exec: (command, args) => {
      probes.push([command, ...args]);
      const tool = args.at(-2) ?? '';
      return Promise.resolve({ code: runnable.includes(tool) ? 0 : 1, stdout: '' });
    },
    stat: (path) => Promise.resolve(tree[path]?.facts ?? null),
    realpath: (path) => {
      let current = path;
      for (let hops = 0; hops < 8; hops += 1) {
        const entry = tree[current];
        if (entry === undefined) {
          return Promise.resolve(null);
        }
        if (entry.facts.kind !== 'symlink') {
          return Promise.resolve(current);
        }
        current = entry.target ?? '';
      }
      return Promise.resolve(null);
    },
  };
  return { host, probes };
}

const file = (uid = 0, mode = 0o755): FakeEntry => ({ facts: { uid, mode, kind: 'file' } });
const link = (target: string, uid = 0): FakeEntry => ({
  facts: { uid, mode: 0o755, kind: 'symlink' },
  target,
});

describe('toolchain detection (#634 PR 2, #772, R-ROOT-1/2)', () => {
  it('takes Homebrew’s claude and the system git, probing each as _tcjob with an empty environment', async () => {
    const { host, probes } = fakeHost(
      {
        '/opt/homebrew/bin/claude': link('/opt/homebrew/Caskroom/claude-code/2.0/claude', OWNER_UID),
        '/opt/homebrew/Caskroom': { facts: { uid: OWNER_UID, mode: 0o755, kind: 'directory' } },
        '/opt/homebrew/Caskroom/claude-code': { facts: { uid: OWNER_UID, mode: 0o755, kind: 'directory' } },
        '/opt/homebrew/Caskroom/claude-code/2.0': {
          facts: { uid: OWNER_UID, mode: 0o755, kind: 'directory' },
        },
        '/opt/homebrew/Caskroom/claude-code/2.0/claude': file(OWNER_UID),
        '/usr/bin/git': file(),
        '/usr/local/bin/node': file(),
      },
      ['/opt/homebrew/bin/claude', '/usr/bin/git', '/usr/local/bin/node'],
    );
    const detected = await detectToolchain(host, '/usr/bin:/bin');
    expect(detected.toolchain).toEqual({
      claude: '/opt/homebrew/bin/claude',
      path: '/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin',
    });
    expect(probes).toContainEqual([
      '/usr/bin/sudo',
      '-n',
      '-u',
      '_tcjob',
      '--',
      '/usr/bin/env',
      '-i',
      'HOME=/var/empty',
      'PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      '/opt/homebrew/bin/claude',
      '--version',
    ]);
    // Homebrew belongs to the login user: kept, with the residual stated (R-ROOT-2).
    expect(detected.warnings).toEqual([
      expect.stringContaining('claude /opt/homebrew/bin/claude belongs to uid 501, not root'),
    ]);
    // Every probe is `sudo -u _tcjob`: nothing third-party runs as root.
    expect(probes.every((probe) => probe.slice(0, 4).join(' ') === '/usr/bin/sudo -n -u _tcjob')).toBe(true);
  });

  it('refuses claude under a user’s home with the system-wide fix, and fails when nothing else is found', async () => {
    const { host } = fakeHost({ '/Users/owner/.local/bin/claude': file(OWNER_UID), '/usr/bin/git': file() }, [
      '/Users/owner/.local/bin/claude',
      '/usr/bin/git',
    ]);
    await expect(detectToolchain(host, '/Users/owner/.local/bin:/usr/bin')).rejects.toThrow(
      /claude: \/Users\/owner\/\.local\/bin\/claude: under a user's home.*brew install --cask claude-code/,
    );
  });

  it('refuses a tool in a group- or world-writable directory and takes the next candidate', async () => {
    const { host } = fakeHost(
      {
        '/opt/homebrew/bin': { facts: { uid: OWNER_UID, mode: 0o775, kind: 'directory' } },
        '/opt/homebrew/bin/git': file(OWNER_UID),
        '/usr/local/bin/claude': file(),
        '/usr/bin/git': file(),
      },
      ['/opt/homebrew/bin/git', '/usr/local/bin/claude', '/usr/bin/git'],
    );
    const detected = await detectToolchain(host, '');
    expect(detected.tools.map((tool) => tool.path)).toEqual(['/usr/local/bin/claude', '/usr/bin/git']);
    expect(detected.warnings).toEqual(['node: not found']);
  });

  it('refuses a world-writable file even in a root-owned directory', async () => {
    const { host } = fakeHost({ '/usr/local/bin/claude': file(0, 0o777), '/usr/bin/git': file() }, [
      '/usr/local/bin/claude',
      '/usr/bin/git',
    ]);
    await expect(detectToolchain(host, '')).rejects.toThrow(
      /\/usr\/local\/bin\/claude is writable by group or others/,
    );
  });

  it('refuses a candidate _tcjob cannot run (the Command Line Tools stub, a home it cannot traverse)', async () => {
    const { host } = fakeHost({ '/usr/local/bin/claude': file(), '/usr/bin/git': file() }, [
      '/usr/local/bin/claude',
    ]);
    await expect(detectToolchain(host, '')).rejects.toThrow(/git: \/usr\/bin\/git: _tcjob cannot run it/);
  });

  it('looks in the release’s own node first, then Homebrew, then the system, then the given PATH', () => {
    expect(
      candidatesOf('node', '/custom/bin:relative:/usr/local/bin/', '/usr/local/lib/team-console-runner'),
    ).toEqual([
      '/usr/local/lib/team-console-runner/node',
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/custom/bin/node',
    ]);
    expect(candidatesOf('git', '', undefined)).toEqual([
      '/opt/homebrew/bin/git',
      '/usr/local/bin/git',
      '/usr/bin/git',
    ]);
  });

  it('builds the job PATH from the tools’ directories, each once, then the system’s', () => {
    expect(
      jobPathOf([
        { tool: 'claude', path: '/opt/homebrew/bin/claude', ownerUid: null },
        { tool: 'git', path: '/usr/bin/git', ownerUid: null },
        { tool: 'node', path: '/opt/homebrew/bin/node', ownerUid: null },
      ]),
    ).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });
});
