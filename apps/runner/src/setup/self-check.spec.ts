import { RUNNER_VERSION } from '../version';
import { parseRunnerHalfReport, sudoRulesOf } from './self-check';
import { isSignInUrl } from './sign-in-url';

describe('isSignInUrl (R-TOK-2)', () => {
  it.each([
    'https://claude.ai/oauth/authorize?code=true',
    'https://console.anthropic.com/oauth/code/callback',
  ])('opens %s', (url) => {
    expect(isSignInUrl(url)).toBe(true);
  });

  it.each([
    'http://claude.ai/oauth',
    'https://claude.ai.evil.example/oauth',
    'https://evilanthropic.com/x',
    'https://anthropic.com.evil.example/x',
    'https://.anthropic.com/x',
    'https://user:pass@claude.ai/x',
    'https://claude.ai:8443/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://claude.ai/x y',
    `https://claude.ai/${'a'.repeat(2100)}`,
  ])('refuses %s', (url) => {
    expect(isSignInUrl(url)).toBe(false);
  });
});

describe('sudoRulesOf', () => {
  it('reads the rule lines after the header, normalised, and none of the Defaults', () => {
    const listing = [
      'Matching Defaults entries for _tcrunner on mac:',
      '    !use_pty, !lecture',
      '',
      'User _tcrunner may run the following commands on mac:',
      '    (_tcjob)   NOPASSWD: /usr/local/lib/team-console-runner/bin/job-exec',
      '',
    ].join('\n');
    expect(sudoRulesOf(listing)).toEqual(['(_tcjob) NOPASSWD: /usr/local/lib/team-console-runner/bin/job-exec']);
    expect(sudoRulesOf('User _tcrunner is not allowed to run sudo on mac.')).toEqual([]);
  });
});

describe('parseRunnerHalfReport', () => {
  const report = {
    version: RUNNER_VERSION,
    failure: null,
    config: {
      name: 'Owner Mac',
      apiUrl: 'https://team-console-dev.geeera.workers.dev',
      backend: 'user',
      credential: { kind: 'setup-token', file: 'credentials/claude-setup-token' },
      toolchain: { path: '/usr/bin:/bin', claude: '/opt/homebrew/bin/claude' },
    },
    self: { belowMinimum: false, pausedUntil: null, projects: [{ slug: 'team-console', accessSource: 'subscription' }] },
  };

  it('takes the runner half’s one JSON line', () => {
    expect(parseRunnerHalfReport(`${JSON.stringify(report)}\n`)).toEqual(report);
  });

  it.each<[string, unknown]>([
    ['text that is not JSON', 'Enrolled …'],
    ['an unknown credential kind', { ...report, config: { ...report.config, credential: { kind: 'oauth', file: null } } }],
    ['an unknown access source', { ...report, self: { ...report.self, projects: [{ slug: 'x', accessSource: 'free' }] } }],
    ['an unknown failure stage', { ...report, failure: { stage: 'other', message: 'x' } }],
  ])('refuses %s', (_case, value) => {
    expect(parseRunnerHalfReport(typeof value === 'string' ? value : JSON.stringify(value))).toBeNull();
  });
});
