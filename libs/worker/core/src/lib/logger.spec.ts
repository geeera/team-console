import { ENROLMENT_CODE_PREFIX, JOB_TOKEN_PREFIX, type SecretKind } from '@shared/redaction';
import { createLogger, redact } from './logger';

const JWT_SENTINEL = 'eyJhbGciOiJSUzI1NiJ9.sentinel.signature';
const PAT_SENTINEL = 'github_pat_11AAAAAAA0sentinelsentinel';
const CLASSIC_SENTINEL = 'ghp_sentinelsentinelsentinel1234';

// Sentinels are assembled at run time so the repository's secret scanners never see a token-shaped literal.
const join = (...parts: string[]): string => parts.join('');

/**
 * One sentinel per format of the shared list (#467, ADR 0008 row 2-A "sentinel test for tokens/codes in logs"): the
 * logger masks every one of them, whole and cut off, in a message, a field and a nested value.
 */
const FORMATS: readonly (readonly [string, SecretKind, string])[] = [
  ['a console job token', 'job-token', join(JOB_TOKEN_PREFIX, 'k'.repeat(43))],
  ['a job token cut off', 'job-token', join(JOB_TOKEN_PREFIX, 'k'.repeat(9))],
  ['TC_JOB_TOKEN in an environment dump', 'job-token', join('TC_JOB', '_TOKEN=', 'opaque-value-1234')],
  ['a runner enrolment code', 'enrolment-code', join(ENROLMENT_CODE_PREFIX, 'e'.repeat(43))],
  ['a GitHub installation token', 'github-token', join('gh', 's_', 'A1b2'.repeat(9))],
  ['a GitHub fine-grained PAT', 'github-token', PAT_SENTINEL],
  ['a GitLab token', 'gitlab-token', join('gl', 'pat-', 'aB3_-'.repeat(4))],
  ['a JWT', 'jwt', JWT_SENTINEL],
  ['an Anthropic key', 'anthropic-key', join('sk-', 'ant-', 'api03-', 'w'.repeat(40))],
  ['an npm token', 'npm-token', join('np', 'm_', 'Qw3e'.repeat(9))],
  ['an AWS access key id', 'aws-access-key', join('AK', 'IA', 'Z7Q2'.repeat(4))],
  [
    'a PEM private key',
    'private-key',
    join('-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END ', 'PRIVATE KEY-----'),
  ],
];

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe('redact', () => {
  it('replaces credential headers whatever their casing', () => {
    expect(
      redact({
        Authorization: `Bearer ${JWT_SENTINEL}`,
        'Cf-Access-Jwt-Assertion': JWT_SENTINEL,
        cookie: 'a=b',
        'X-Runner-Jwt': JWT_SENTINEL,
      }),
    ).toEqual({
      Authorization: '[redacted]',
      'Cf-Access-Jwt-Assertion': '[redacted]',
      cookie: '[redacted]',
      'X-Runner-Jwt': '[redacted]',
    });
  });

  it('masks a JWT inside free text', () => {
    expect(redact(`verify failed for ${JWT_SENTINEL} (kid 1)`)).toBe(
      'verify failed for [redacted:jwt] (kid 1)',
    );
  });

  it('masks GitHub tokens inside free text and nested values', () => {
    const result = redact({
      note: `token ${PAT_SENTINEL} and ${CLASSIC_SENTINEL}`,
      nested: [{ t: PAT_SENTINEL }],
    });
    expect(JSON.stringify(result)).not.toContain(PAT_SENTINEL);
    expect(JSON.stringify(result)).not.toContain(CLASSIC_SENTINEL);
    expect(result).toEqual({
      note: 'token [redacted:github-token] and [redacted:github-token]',
      nested: [{ t: '[redacted:github-token]' }],
    });
  });

  it.each(['ghs', 'ghu', 'ghr', 'gho'])('masks a GitHub %s_ token', (prefix) => {
    const token = `${prefix}_${'TESTSENTINEL'.repeat(3)}`;
    expect(redact(`minted ${token} for acme/app`)).toBe('minted [redacted:github-token] for acme/app');
  });

  it('masks a routine trigger token (#114), whole or cut off', () => {
    const token = ['sk', 'ant', 'oat01', 'TESTSENTINEL_x-y'].join('-');
    expect(redact(`fire with ${token} failed`)).toBe('fire with [redacted:anthropic-key] failed');
    expect(redact({ header: `Bearer ${token.slice(0, 12)}` })).toEqual({
      header: 'Bearer [redacted:anthropic-key]',
    });
  });

  it.each(FORMATS)('masks %s in a message, a field and a nested value', (_, kind, secret) => {
    const result = redact({
      message: `failed with ${secret} at step 3`,
      field: secret,
      nested: { list: [`x ${secret} y`] },
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain(secret.slice(-12));
    expect(output).toContain(`[redacted:${kind}]`);
  });

  it('drops the query of any URL in free text, keeping the path', () => {
    const result = redact({
      url: 'https://team-console.example/api/v1/github/callback?code=SENTINELCODE&state=SENTINELSTATE',
      note: 'redirected to http://localhost:8787/settings?github=connected#top then stopped',
    });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
    expect(result).toEqual({
      url: 'https://team-console.example/api/v1/github/callback?[redacted]',
      note: 'redirected to http://localhost:8787/settings?[redacted]#top then stopped',
    });
  });

  it('masks a PEM private key whole, and a truncated one to the end of the text', () => {
    const armor = (edge: 'BEGIN' | 'END', kind = '') => `-----${edge} ${kind}${'PRIVATE'} KEY-----`;
    const pem = `${armor('BEGIN')}\n${'A'.repeat(32)}\n${armor('END')}`;
    expect(redact(`key: ${pem} (app 1)`)).toBe('key: [redacted:private-key] (app 1)');
    expect(redact(`bad ${armor('BEGIN', 'RSA ')}\nMIIEow`)).toBe('bad [redacted:private-key]');
    expect(redact(`not an RSA ${'PRIVATE'} KEY`)).not.toContain(`${'PRIVATE'} KEY`);
  });

  it('serialises errors with their cause and redacts inside them', () => {
    const error = new Error(`failed with ${PAT_SENTINEL}`, { cause: { authorization: 'x' } });
    const result = redact(error) as Record<string, unknown>;
    expect(result['name']).toBe('Error');
    expect(result['message']).toBe('failed with [redacted:github-token]');
    expect(result['cause']).toEqual({ authorization: '[redacted]' });
    expect(typeof result['stack']).toBe('string');
  });

  it('reads Headers instances', () => {
    const headers = new Headers({ 'X-Request-Id': 'r1', Authorization: 'secret' });
    expect(redact(headers)).toEqual({ 'x-request-id': 'r1', authorization: '[redacted]' });
  });

  it('stops at a bounded depth instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect(JSON.stringify(redact(cyclic))).toContain('[truncated]');
  });
});

describe('createLogger', () => {
  it('writes one JSON line with level, message, context and fields', () => {
    const { lines, sink } = capture();
    createLogger({ service: 'api', requestId: 'req-1' }, sink).info('hello', { route: '/x' });

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'info',
      message: 'hello',
      service: 'api',
      requestId: 'req-1',
      route: '/x',
    });
    expect(typeof line['ts']).toBe('string');
  });

  it('never lets a token or an Access JWT reach the sink', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ requestId: 'req-2' }, sink);
    logger.warn(`retrying with ${CLASSIC_SENTINEL}`, {
      headers: { 'cf-access-jwt-assertion': JWT_SENTINEL },
      error: new Error(PAT_SENTINEL),
    });

    const output = lines.join('\n');
    expect(output).not.toContain(JWT_SENTINEL);
    expect(output).not.toContain(PAT_SENTINEL);
    expect(output).not.toContain(CLASSIC_SENTINEL);
  });

  // The sentinel of the #474 review: a job token in any position of a log call never reaches a line.
  it('never lets a job token or an enrolment code reach a log line, wherever it sits', () => {
    const jobToken = join(JOB_TOKEN_PREFIX, 'S'.repeat(43));
    const code = join(ENROLMENT_CODE_PREFIX, 'C'.repeat(43));
    const { lines, sink } = capture();
    const logger = createLogger({ requestId: 'req-3', token: jobToken }, sink);
    logger.info(`claimed with ${jobToken}`, {
      authorization: `Bearer ${jobToken}`,
      body: { code, env: [`TC_JOB_TOKEN=${jobToken}`] },
      error: new Error(`refused ${code}`, { cause: jobToken }),
    });
    logger.error(jobToken.slice(0, 20));

    const output = lines.join('\n');
    expect(output).not.toContain(jobToken);
    expect(output).not.toContain(jobToken.slice(0, 20));
    expect(output).not.toContain(code);
    expect(output).toContain('[redacted:job-token]');
    expect(output).toContain('[redacted:enrolment-code]');
  });

  it('survives values JSON cannot serialise', () => {
    const { lines, sink } = capture();
    createLogger({}, sink).error('big', { n: BigInt(1) });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      level: 'error',
      message: 'log line could not be serialised',
    });
  });

  it('defaults to console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createLogger({}).info('to console');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
