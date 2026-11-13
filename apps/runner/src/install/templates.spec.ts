import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCUMENTED_DEFAULTS, launchDaemonPlist, sudoersRule } from './templates';

/**
 * The committed service files are the installer's templates rendered with the documented defaults, so what a reviewer
 * reads in `apps/runner/launchd` and `apps/runner/sudoers` is what `install` writes. `bin/job-exec` is the wrapper the
 * sudoers rule names (threat model L3).
 */

const app = join(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(join(app, path), 'utf8');

describe('service files', () => {
  it('the LaunchDaemon runs the runner as _tcrunner with umask 027', () => {
    const plist = read('launchd/com.team-console.runner.plist');
    expect(plist).toBe(launchDaemonPlist(DOCUMENTED_DEFAULTS));
    expect(plist).toContain('<key>UserName</key><string>_tcrunner</string>');
    expect(plist).toContain('<key>Umask</key><integer>23</integer>');
  });

  it('sudoers holds one rule: _tcrunner may run job-exec as _tcjob, nothing else', () => {
    const sudoers = read('sudoers/team-console-runner');
    expect(sudoers).toBe(sudoersRule(DOCUMENTED_DEFAULTS.prefix));
    const lines = sudoers.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(lines).toEqual([
      'Defaults:_tcrunner !use_pty, !lecture',
      '_tcrunner ALL=(_tcjob) NOPASSWD: /usr/local/lib/team-console-runner/bin/job-exec',
    ]);
  });

  it('job-exec offers run, reap and sweep only, and reaps with the pkill exec’d in place', () => {
    const script = read('bin/job-exec');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect([...script.matchAll(/^ {2}([a-z*]+)\)$/gm)].map((match) => match[1])).toEqual([
      'run',
      'reap',
      'sweep',
      '*',
    ]);
    expect(script).toContain('exec node "$prefix/team-console-runner.mjs" job-exec');
    expect(script).toContain('exec /usr/bin/pkill -9 -u "$uid"');
    for (const dir of ['/tmp', '/private/var/tmp', '/Users/Shared']) {
      expect(script).toContain(` ${dir} `);
    }
    expect(script).toContain('-xdev -mindepth 1 -user "$uid" -print -delete');
  });
});
