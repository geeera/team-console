import { JOB_TOKEN_PREFIX, findSecret, redactSecrets, type SecretKind } from './secrets';

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
  ['TC_JOB_TOKEN as an assignment', 'job-token', join('TC_JOB', '_TOKEN=', 'opaque-value-1234')],
  ['TC_JOB_TOKEN quoted after a colon', 'job-token', join('TC_JOB', '_TOKEN: "', 'opaque-value-1234"')],
  ['an Anthropic API key', 'anthropic-key', join('sk-', 'ant-', 'api03-', 'w'.repeat(40))],
];

describe('findSecret', () => {
  it.each(SECRETS)('finds %s', (_, kind, secret) => {
    expect(findSecret(secret)).toBe(kind);
    expect(findSecret(`Fixed the deploy.\n\nUsed ${secret} to check it, then\nrevoked it.`)).toBe(kind);
  });

  it.each([
    ['plain prose', 'The job token is stored as a hash; GitHub tokens start with a prefix.'],
    ['a prefix without a token', join('gh', 's_ and gh', 'p_ and gl', 'pat- and ', JOB_TOKEN_PREFIX)],
    ['a token prefix too short to be a token', join('gh', 's_', 'abc123')],
    ['a prefix inside a longer word', join('xgh', 's_', 'a'.repeat(36))],
    ['a job-token prefix with too few characters', join(JOB_TOKEN_PREFIX, 'k'.repeat(42))],
    ['a job-token prefix with too many characters', join(JOB_TOKEN_PREFIX, 'k'.repeat(44))],
    ['one base64 segment that is no JWT', b64url('{"just":"json"}')],
    ['the name of the variable alone', join('Set TC_JOB', '_TOKEN in the environment')],
    ['a public key', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----'],
    ['a commit SHA and a UUID', '3649d7c0f1e2d3c4b5a69788 and 0f55c5e5-b132-4335-b77c-4d06a92b6ebf'],
    ['an empty text', ''],
  ])('finds nothing in %s', (_, text) => {
    expect(findSecret(text)).toBeNull();
  });

  it('scans a long text with many near-misses quickly', () => {
    const text = join('eyJ', 'a-'.repeat(32_000));
    const started = performance.now();
    expect(findSecret(text)).toBeNull();
    expect(redactSecrets(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(1_000);
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
