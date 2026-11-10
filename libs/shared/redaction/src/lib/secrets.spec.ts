import {
  ENROLMENT_CODE_PREFIX,
  JOB_TOKEN_PREFIX,
  SECRET_KINDS,
  findSecret,
  redactSecrets,
  type SecretKind,
} from './secrets';

// Fixtures are assembled at run time, so the repository's secret scan never sees a literal token-shaped string.
const join = (...parts: string[]): string => parts.join('');
const b64url = (text: string): string =>
  btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = join(
  b64url('{"alg":"HS256","typ":"JWT"}'),
  '.',
  b64url('{"sub":"job-1","exp":1}'),
  '.',
  'c2lnbmF0dXJlLWJ5dGVz',
);
const pem = (type: string): string =>
  join(
    '-----BEGIN ',
    type,
    'PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQ\n-----END ',
    type,
    'PRIVATE KEY-----',
  );

const SECRETS: readonly (readonly [string, SecretKind, string])[] = [
  ['a GitHub installation token', 'github-token', join('gh', 's_', 'A1b2'.repeat(9))],
  ['a GitHub classic PAT', 'github-token', join('gh', 'p_', 'Z9y8'.repeat(9))],
  ['a GitHub OAuth token', 'github-token', join('gh', 'o_', 'x'.repeat(36))],
  ['a GitHub user-to-server token', 'github-token', join('gh', 'u_', 'x'.repeat(36))],
  ['a GitHub refresh token', 'github-token', join('gh', 'r_', 'x'.repeat(76))],
  [
    'a GitHub fine-grained PAT',
    'github-token',
    join('github', '_pat_', '11AB'.repeat(6), '_', 'q'.repeat(59)),
  ],
  ['a GitLab PAT', 'gitlab-token', join('gl', 'pat-', 'aB3_-'.repeat(4))],
  ['a JWT', 'jwt', jwt],
  ['an unsigned JWT', 'jwt', `${jwt.slice(0, jwt.lastIndexOf('.'))}.`],
  ['an RSA private key', 'private-key', pem('RSA ')],
  ['an OpenSSH private key', 'private-key', pem('OPENSSH ')],
  ['a PKCS#8 private key', 'private-key', pem('')],
  ['an encrypted private key', 'private-key', pem('ENCRYPTED ')],
  ['a private key cut off before its END line', 'private-key', pem('EC ').split('-----END')[0] ?? ''],
  ['a console job token', 'job-token', join(JOB_TOKEN_PREFIX, 'k'.repeat(43))],
  ['a runner enrolment code', 'enrolment-code', join(ENROLMENT_CODE_PREFIX, 'e'.repeat(43))],
  ['TC_JOB_TOKEN as an assignment', 'job-token', join('TC_JOB', '_TOKEN=', 'opaque-value-1234')],
  ['TC_JOB_TOKEN quoted after a colon', 'job-token', join('TC_JOB', '_TOKEN: "', 'opaque-value-1234"')],
  ['an Anthropic API key', 'anthropic-key', join('sk-', 'ant-', 'api03-', 'w'.repeat(40))],
  [
    'a PGP private key block',
    'private-key',
    join('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\n\nlQOYBF\n-----END PGP ', 'PRIVATE KEY BLOCK-----'),
  ],
  ['an npm token', 'npm-token', join('np', 'm_', 'Qw3e'.repeat(9))],
  ['an AWS access key id', 'aws-access-key', join('AK', 'IA', 'Z7Q2'.repeat(4))],
  ['an AWS temporary access key id', 'aws-access-key', join('AS', 'IA', 'Z7Q2'.repeat(4))],
];

const GITHUB = join('gh', 'p_', 'Z9y8'.repeat(9));

describe('findSecret', () => {
  it.each(SECRETS)('finds %s', (_, kind, secret) => {
    expect(findSecret(secret)).toBe(kind);
    expect(findSecret(`Fixed the deploy.\n\nUsed ${secret} to check it, then\nrevoked it.`)).toBe(kind);
  });

  it.each([
    ['plain prose', 'The job token is stored as a hash; GitHub tokens start with a prefix.'],
    [
      'a prefix without a token',
      join('gh', 's_ and gh', 'p_ and gl', 'pat- and ', JOB_TOKEN_PREFIX, ' and ', ENROLMENT_CODE_PREFIX),
    ],
    ['a token prefix too short to be a token', join('gh', 's_', 'abc123')],
    ['a job-token prefix with too few characters', join(JOB_TOKEN_PREFIX, 'k'.repeat(42))],
    ['npm words', 'Run npm_config_cache=1 npm install; see npm_package_version.'],
    [
      'an AWS-like prefix with a short or lower-case tail',
      join('AK', 'IA12345 and AS', 'IAabcdefghijklmnop'),
    ],
    [
      'a PGP public key block',
      '-----BEGIN PGP PUBLIC KEY BLOCK-----\nmQINBF\n-----END PGP PUBLIC KEY BLOCK-----',
    ],
    ['one base64 segment that is no JWT', b64url('{"just":"json"}')],
    ['the name of the variable alone', join('Set TC_JOB', '_TOKEN in the environment')],
    ['a public key', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----'],
    ['a commit SHA and a UUID', '3649d7c0f1e2d3c4b5a69788 and 0f55c5e5-b132-4335-b77c-4d06a92b6ebf'],
    ['an empty text', ''],
  ])('finds nothing in %s', (_, text) => {
    expect(findSecret(text)).toBeNull();
  });

  // #474 review: no word-boundary anchor, so a token glued to a word or an underscore is still found.
  it.each([
    ['glued after a word', join('token', GITHUB)],
    ['glued after an underscore', join('GH_TOKEN_', GITHUB)],
    ['followed by an underscore', join(GITHUB, '_x')],
    ['inside a longer word', join('x', GITHUB, 'y')],
  ])('finds a GitHub token %s', (_, text) => {
    expect(findSecret(text)).toBe('github-token');
  });

  it('finds a job token in a longer run (fail closed)', () => {
    expect(findSecret(join(JOB_TOKEN_PREFIX, 'k'.repeat(44)))).toBe('job-token');
    expect(findSecret(join('X', JOB_TOKEN_PREFIX, 'k'.repeat(43)))).toBe('job-token');
  });

  it.each([
    ['one JWT prefix and a long tail', join('eyJ', 'a-'.repeat(32_000))],
    ['JWT prefixes back to back', 'eyJ'.repeat(21_000)],
    ['JWT prefixes between dashes', 'eyJ-'.repeat(16_000)],
    ['GitHub prefixes back to back', join('gh', 'p_').repeat(16_000)],
    ['private-key headers without an end', '-----BEGIN PRIVATE KEY-'.repeat(2_500)],
  ])('scans a 64 KB text of %s quickly', (_, text) => {
    const started = performance.now();
    findSecret(text);
    redactSecrets(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('the JWT prefix guard (#474 re-review)', () => {
  // The JWT pattern alone has a prefix guard: `eyJ` inside a base64url run is a continuation, not a header start.
  it('does not read eyJ inside a base64url run as a JWT start, and still finds a delimited JWT', () => {
    expect(findSecret(join('abc', jwt))).toBeNull();
    expect(findSecret(join('token=', jwt))).toBe('jwt');
    expect(findSecret(join('(', jwt, ')'))).toBe('jwt');
    expect(redactSecrets(join('abc', jwt), 'loose')).toBe(join('abc', jwt));
  });

  it('scans a 64 KB field of eyJ characters well inside the review’s budget', () => {
    const field = 'eyJ'.repeat(21_846).slice(0, 65_536);
    const started = performance.now();
    findSecret(field);
    redactSecrets(field);
    redactSecrets(field, 'loose');
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('SECRET_KINDS', () => {
  it('names every kind a fixture covers, so a sentinel spec over the list covers each one', () => {
    expect([...SECRET_KINDS].sort()).toEqual([...new Set(SECRETS.map(([, kind]) => kind))].sort());
  });
});

describe('redactSecrets in loose mode (logs and audit rows)', () => {
  const cutOff: readonly (readonly [string, SecretKind, string])[] = [
    ['a GitHub token cut after a few characters', 'github-token', join('gh', 's_', 'abc1')],
    ['a fine-grained PAT cut short', 'github-token', join('github', '_pat_', '11AB')],
    ['a GitLab token cut short', 'gitlab-token', join('gl', 'pat-', 'aB3')],
    ['a routine trigger token cut short (#114)', 'anthropic-key', join('sk-', 'ant-', 'oat01')],
    ['a job token cut short', 'job-token', join(JOB_TOKEN_PREFIX, 'k'.repeat(10))],
    ['an enrolment code cut short', 'enrolment-code', join(ENROLMENT_CODE_PREFIX, 'e'.repeat(10))],
    ['TC_JOB_TOKEN with a short value', 'job-token', join('TC_JOB', '_TOKEN=', 'abc')],
    [
      'a JWT whose payload is not a JSON object',
      'jwt',
      join('eyJ', 'hbGciOiJSUzI1NiJ9', '.sentinel.signature'),
    ],
    ['the bare words of a PEM header', 'private-key', join('PRIVATE', ' KEY')],
  ];

  it.each(cutOff)('masks %s in loose mode, which strict mode leaves alone', (_, kind, secret) => {
    expect(redactSecrets(`before ${secret} after`, 'loose')).toBe(`before [redacted:${kind}] after`);
    expect(findSecret(`before ${secret} after`)).toBeNull();
  });

  it.each(SECRETS)('masks %s as strict mode does', (_, kind, secret) => {
    const masked = redactSecrets(`before ${secret} after`, 'loose');
    expect(masked).toContain(`[redacted:${kind}]`);
    expect(masked).not.toContain(secret.slice(-12));
  });

  it('keeps ordinary npm and AWS-like words and a bare prefix', () => {
    const text = join('npm_config_cache=1 and AK', 'IA12345 and gh', 's_ alone');
    expect(redactSecrets(text, 'loose')).toBe(text);
  });
});

describe('redactSecrets', () => {
  const delimited = SECRETS.filter(([name]) => !name.includes('cut off') && !name.includes('quoted'));

  it.each(delimited)('masks %s and keeps the text around it', (_, kind, secret) => {
    expect(redactSecrets(`before ${secret} after`)).toBe(`before [redacted:${kind}] after`);
  });

  it('masks a private key without an END line up to the end of the text, fail-safe', () => {
    const cut = pem('EC ').split('-----END')[0] ?? '';
    expect(redactSecrets(`before ${cut} after`)).toBe('before [redacted:private-key]');
  });

  it('masks a quoted TC_JOB_TOKEN value, keeping the closing quote', () => {
    expect(redactSecrets(join('export TC_JOB', '_TOKEN="', 'opaque-value-1234";'))).toBe(
      'export [redacted:job-token]";',
    );
  });

  it('masks every secret in a text, each by its kind', () => {
    const github = join('gh', 's_', 'A1b2'.repeat(9));
    const job = join(JOB_TOKEN_PREFIX, 'k'.repeat(43));
    expect(redactSecrets(`${github}\n${job}\n${github}`)).toBe(
      '[redacted:github-token]\n[redacted:job-token]\n[redacted:github-token]',
    );
  });

  it('is the same on a second call (no state carried between calls)', () => {
    const text = `a ${jwt} b`;
    expect(redactSecrets(text)).toBe(redactSecrets(text));
    expect(findSecret(text)).toBe('jwt');
    expect(findSecret(text)).toBe('jwt');
  });

  it('leaves a text without a secret untouched', () => {
    expect(redactSecrets('Nothing to hide here.')).toBe('Nothing to hide here.');
  });
});
