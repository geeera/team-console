import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Exec } from '../host/exec';
import { systemInstallHost, type InstallHost } from './install';

/**
 * #598 (SECURITY review on #632): the real host sets owner and mode on the `O_NOFOLLOW` handle it opened, never by
 * path, so nothing `_tcrunner` swaps in under its home after the open (a symlink, a hard link to a root-owned file) is
 * chowned or chmodded. Path-based calls are spied on through a pass-through mock of `node:fs/promises`.
 */

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    chmod: vi.fn(real.chmod),
    lchmod: vi.fn(real.lchmod),
    chown: vi.fn(real.chown),
    lchown: vi.fn(real.lchown),
    mkdir: vi.fn(real.mkdir),
    open: vi.fn(real.open),
  };
});

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;
const OWNER = 'tcrunner:tcjob';

describe('systemInstallHost sets owner and mode through the handle', () => {
  let root: string;
  let queries: string[];
  let handleCalls: { chown: unknown[][]; chmod: unknown[][] };

  const exec: Exec = async (command, args) => {
    const line = [command, ...args].join(' ');
    queries.push(line);
    if (line === '/usr/bin/id -u tcrunner') {
      return { code: 0, stdout: `${String(uid)}\n` };
    }
    if (line === '/usr/bin/dscl . -read /Groups/tcjob PrimaryGroupID') {
      return { code: 0, stdout: `PrimaryGroupID: ${String(gid)}\n` };
    }
    return { code: 1, stdout: '' };
  };
  const host = (): InstallHost =>
    systemInstallHost({ platform: process.platform, uid: 0, homeDir: '/nonexistent', exec });
  const pathCalls = (): number =>
    [fs.chmod, fs.lchmod, fs.chown, fs.lchown].reduce((sum, fn) => sum + vi.mocked(fn).mock.calls.length, 0);

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'install-host-'));
    queries = [];
    handleCalls = { chown: [], chmod: [] };
    vi.mocked(fs.open).mockImplementation(
      async (...args: Parameters<typeof fs.open>): Promise<FileHandle> => {
        const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const handle = await real.open(...args);
        const chown = handle.chown.bind(handle);
        const chmod = handle.chmod.bind(handle);
        handle.chown = async (...call) => {
          handleCalls.chown.push(call);
          await chown(...call);
        };
        handle.chmod = async (...call) => {
          handleCalls.chmod.push(call);
          await chmod(...call);
        };
        return handle;
      },
    );
    vi.mocked(fs.chmod).mockClear();
    vi.mocked(fs.lchmod).mockClear();
    vi.mocked(fs.chown).mockClear();
    vi.mocked(fs.lchown).mockClear();
  });

  afterEach(async () => {
    vi.mocked(fs.open).mockReset();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('mkdir: fchown to the resolved ids, then fchmod, and no chown or chmod by path', async () => {
    const path = join(root, 'home');
    await host().apply({ kind: 'mkdir', path, mode: 0o710, owner: OWNER });
    expect(handleCalls.chown).toEqual([[uid, gid]]);
    expect(handleCalls.chmod).toEqual([[0o710]]);
    expect(pathCalls()).toBe(0);
    expect(queries.some((query) => query.startsWith('/usr/sbin/chown'))).toBe(false);
    expect((await fs.lstat(path)).mode & 0o7777).toBe(0o710);
  });

  it('write: fchown and fchmod on the O_NOFOLLOW handle, no chown by path', async () => {
    const path = join(root, 'settings.json');
    await host().apply({ kind: 'write', path, mode: 0o644, owner: OWNER, content: '{}\n' });
    expect(handleCalls.chown).toEqual([[uid, gid]]);
    expect(handleCalls.chmod).toEqual([[0o644]]);
    expect(pathCalls()).toBe(0);
    expect(await fs.readFile(path, 'utf8')).toBe('{}\n');
  });

  it('refuses a hard link to a file planted where a directory belongs, and never chowns or chmods it', async () => {
    const target = join(root, 'root-owned-file');
    await fs.writeFile(target, 'secret');
    await fs.chmod(target, 0o600);
    vi.mocked(fs.chmod).mockClear();
    const link = join(root, 'logs');
    await fs.link(target, link);
    // The swap lands after mkdir succeeded: the O_DIRECTORY | O_NOFOLLOW open itself must refuse it.
    vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
    await expect(host().apply({ kind: 'mkdir', path: link, mode: 0o700, owner: OWNER })).rejects.toThrow(
      /logs is not a directory/,
    );
    expect(handleCalls.chown).toEqual([]);
    expect(handleCalls.chmod).toEqual([]);
    expect(pathCalls()).toBe(0);
    expect((await fs.lstat(target)).mode & 0o7777).toBe(0o600);
  });

  it('write: refuses a hard link to a victim file and leaves its content, mode and owner alone', async () => {
    const victim = join(root, 'victim');
    await fs.writeFile(victim, 'root secret');
    await fs.chmod(victim, 0o600);
    vi.mocked(fs.chmod).mockClear();
    const before = await fs.lstat(victim);
    const planted = join(root, 'sudoers');
    await fs.link(victim, planted);
    await expect(
      host().apply({ kind: 'write', path: planted, mode: 0o644, owner: OWNER, content: 'pwned\n' }),
    ).rejects.toThrow(/not a regular file with a single link/);
    const after = await fs.lstat(victim);
    expect(await fs.readFile(victim, 'utf8')).toBe('root secret');
    expect([after.mode, after.uid, after.gid]).toEqual([before.mode, before.uid, before.gid]);
    expect(handleCalls.chown).toEqual([]);
    expect(handleCalls.chmod).toEqual([]);
    expect(pathCalls()).toBe(0);
  });

  it('write: replaces the content of an existing single-link file', async () => {
    const path = join(root, 'plist');
    await fs.writeFile(path, 'an older and longer content\n');
    await host().apply({ kind: 'write', path, mode: 0o644, content: 'new\n' });
    expect(await fs.readFile(path, 'utf8')).toBe('new\n');
  });

  it.each(['tcrunner', 'tcrunner:tcjob:extra', ':tcjob', 'tcrunner:'])(
    'refuses owner %j that is not exactly user:group',
    async (owner) => {
      const path = join(root, 'home');
      await expect(host().apply({ kind: 'mkdir', path, mode: 0o710, owner })).rejects.toThrow(
        /owner must be user:group/,
      );
      expect(queries).toEqual([]);
    },
  );

  it('refuses an owner it cannot resolve before touching the path', async () => {
    const path = join(root, 'home');
    await expect(
      host().apply({ kind: 'mkdir', path, mode: 0o710, owner: 'nobody-here:tcjob' }),
    ).rejects.toThrow(/could not resolve user nobody-here/);
    expect(await fs.lstat(path).catch(() => null)).toBeNull();
  });
});
