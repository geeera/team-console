import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateDirectory, realDirectory } from './private-directory';

const modeOf = (path: string): number => statSync(path).mode & 0o777;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'private-directory-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('privateDirectory', () => {
  it('makes a directory for its owner only, and the missing ones above it with the default mode', () => {
    const before = process.umask(0o022);
    try {
      privateDirectory(join(dir, 'run/servers'));
    } finally {
      process.umask(before);
    }

    expect(modeOf(join(dir, 'run/servers'))).toBe(0o700);
    expect(modeOf(join(dir, 'run'))).toBe(0o755);
  });

  it('closes a directory that is already there and open to others, and keeps what is in it', () => {
    const open = join(dir, 'servers');
    mkdirSync(open);
    writeFileSync(join(open, '8700.json'), '{}');
    // Past the umask, which would have closed part of it already.
    chmodSync(open, 0o777);

    privateDirectory(open);

    expect(modeOf(open)).toBe(0o700);
    expect(readdirSync(open)).toEqual(['8700.json']);
  });

  it('gives the owner the bits back that a umask took away', () => {
    const before = process.umask(0o277);
    try {
      privateDirectory(join(dir, 'servers'));
    } finally {
      process.umask(before);
    }

    expect(modeOf(join(dir, 'servers'))).toBe(0o700);
  });

  it('refuses a link, and leaves what the link names as it was', () => {
    const real = join(dir, 'the-real-one');
    mkdirSync(real);
    chmodSync(real, 0o755);
    symlinkSync(real, join(dir, 'servers'));

    expect(() => privateDirectory(join(dir, 'servers'))).toThrow(/servers is a symbolic link/);

    expect(modeOf(real)).toBe(0o755);
    expect(readdirSync(real)).toEqual([]);
  });

  it('refuses a link that names nothing, and a file in its place', () => {
    symlinkSync(join(dir, 'nowhere'), join(dir, 'servers'));
    expect(() => privateDirectory(join(dir, 'servers'))).toThrow();
    expect(readdirSync(dir)).toEqual(['servers']);

    writeFileSync(join(dir, 'records'), '');
    expect(() => privateDirectory(join(dir, 'records'))).toThrow();
    expect(modeOf(join(dir, 'records'))).not.toBe(0o700);
  });

  // Root owns nothing less than everything: there is no directory of another user to refuse.
  it.skipIf(process.getuid?.() === 0)('refuses a directory of another user, and leaves its mode alone', () => {
    const mode = modeOf('/usr');

    expect(() => privateDirectory('/usr')).toThrow(/belongs to another user/);

    expect(modeOf('/usr')).toBe(mode);
  });
});

describe('realDirectory', () => {
  it('answers for a directory, and throws for a link to one and for a file', () => {
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    writeFileSync(join(dir, 'file'), '');

    expect(realDirectory(join(dir, 'real')).isDirectory()).toBe(true);
    expect(() => realDirectory(join(dir, 'link'))).toThrow(/link is a symbolic link/);
    expect(() => realDirectory(join(dir, 'file'))).toThrow(/file is not a directory/);
  });
});
