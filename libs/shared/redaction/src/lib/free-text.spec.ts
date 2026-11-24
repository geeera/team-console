import { findSecretInText, maskSecretsInText } from './free-text';
import { SECRET_KINDS, findSecret, type SecretKind } from './secrets';

// Fixtures are assembled at run time, so the repository's secret scan never sees a literal token-shaped string.
const join = (...parts: string[]): string => parts.join('');
const b64url = (text: string): string =>
  btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TAIL = 'A1b2'.repeat(9);
const OPAQUE = 'Zx9_'.repeat(10) + 'abc';

const SAMPLES: Readonly<Record<SecretKind, string>> = {
  'github-token': join('gh', 'p_', TAIL),
  'gitlab-token': join('gl', 'pat-', 'A1b2C3d4E5f6G7h8I9j0'),
  jwt: join(
    b64url('{"alg":"HS256","typ":"JWT"}'),
    '.',
    b64url('{"sub":"job-1","exp":1}'),
    '.',
    'c2lnbmF0dXJl',
  ),
  'private-key': join(
    '-----BEGIN ',
    'RSA PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END ',
    'RSA PRIVATE KEY-----',
  ),
  'job-token': join('tc', 'j_', OPAQUE),
  'enrolment-code': join('tc', 'e_', OPAQUE),
  'enrolment-poll-token': join('tc', 'ep_', OPAQUE),
  'anthropic-key': join('sk-', 'ant-', 'api03-', 'A1b2C3d4'.repeat(6)),
  'npm-token': join('np', 'm_', 'A1b2C3d4E5f6'.repeat(3)),
  'aws-access-key': join('AK', 'IA', 'IOSFODNN7EXAMPLE'),
};

const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
/** `token` with an invisible character after its fourth character: unreadable to a pattern, the same to a reader. */
const hidden = (token: string, invisible: string): string => token.slice(0, 4) + invisible + token.slice(4);

describe('findSecretInText', () => {
  it('has a sample for every kind the pattern list knows', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...SECRET_KINDS].sort());
  });

  it.each(SECRET_KINDS)('names a %s inside imported prose', (kind) => {
    expect(findSecretInText(`Imported from GitHub: ${SAMPLES[kind]} was the deploy credential`)).toBe(kind);
  });

  it('answers null for text without a secret, a bare prefix included', () => {
    expect(findSecretInText('Rotate the ghs_ and glpat- tokens before the demo')).toBeNull();
    expect(findSecretInText('')).toBeNull();
  });

  it.each([
    ['a zero-width joiner', ZERO_WIDTH_JOINER],
    ['a zero-width space', ZERO_WIDTH_SPACE],
  ])('finds a token split by %s, which the bare pattern list misses', (_, invisible) => {
    const text = `token ${hidden(SAMPLES['github-token'], invisible)}`;
    expect(findSecret(text)).toBeNull();
    expect(findSecretInText(text)).toBe('github-token');
  });
});

describe('maskSecretsInText', () => {
  it('leaves clean text exactly as it came, invisible characters included', () => {
    const text = `Family emoji 👨${ZERO_WIDTH_JOINER}👩 and a plain line\r\n`;
    expect(maskSecretsInText(text)).toEqual({ text, masked: false });
  });

  it.each(SECRET_KINDS)('masks a %s and keeps the text around it', (kind) => {
    const result = maskSecretsInText(`before ${SAMPLES[kind]}\nafter`);
    expect(result.masked).toBe(true);
    expect(result.text).not.toContain(SAMPLES[kind]);
    expect(result.text).toContain(`[redacted:${kind}]`);
    expect(result.text.startsWith('before ')).toBe(true);
    expect(findSecretInText(result.text)).toBeNull();
  });

  it('masks a token hidden by an invisible character, so the result never matches the check', () => {
    const token = SAMPLES['github-token'];
    const result = maskSecretsInText(`see ${hidden(token, ZERO_WIDTH_JOINER)} here`);
    expect(result).toEqual({ text: 'see [redacted:github-token] here', masked: true });
    expect(findSecretInText(result.text)).toBeNull();
  });

  it('masks every token of a text that carries several', () => {
    const result = maskSecretsInText(`${SAMPLES['github-token']} and ${SAMPLES['npm-token']}`);
    expect(result.text).toBe('[redacted:github-token] and [redacted:npm-token]');
  });
});
