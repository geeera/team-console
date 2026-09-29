import { createLogger, redact } from './logger';

const JWT_SENTINEL = 'eyJhbGciOiJSUzI1NiJ9.sentinel.signature';
const PAT_SENTINEL = 'github_pat_11AAAAAAA0sentinelsentinel';
const CLASSIC_SENTINEL = 'ghp_sentinelsentinelsentinel1234';

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
      }),
    ).toEqual({ Authorization: '[redacted]', 'Cf-Access-Jwt-Assertion': '[redacted]', cookie: '[redacted]' });
  });

  it('masks a JWT inside free text', () => {
    expect(redact(`verify failed for ${JWT_SENTINEL} (kid 1)`)).toBe('verify failed for [redacted] (kid 1)');
  });

  it('masks GitHub tokens inside free text and nested values', () => {
    const result = redact({
      note: `token ${PAT_SENTINEL} and ${CLASSIC_SENTINEL}`,
      nested: [{ t: PAT_SENTINEL }],
    });
    expect(JSON.stringify(result)).not.toContain(PAT_SENTINEL);
    expect(JSON.stringify(result)).not.toContain(CLASSIC_SENTINEL);
    expect(result).toEqual({ note: 'token [redacted] and [redacted]', nested: [{ t: '[redacted]' }] });
  });

  // Sentinels are assembled at run time so the repository's secret scanners never see a token-shaped literal.
  it.each(['ghs', 'ghu', 'ghr', 'gho'])('masks a GitHub %s_ token', (prefix) => {
    const token = `${prefix}_${'TESTSENTINEL'.repeat(3)}`;
    expect(redact(`minted ${token} for acme/app`)).toBe('minted [redacted] for acme/app');
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
    expect(redact(`key: ${pem} (app 1)`)).toBe('key: [redacted] (app 1)');
    expect(redact(`bad ${armor('BEGIN', 'RSA ')}\nMIIEow`)).toBe('bad [redacted]');
    expect(redact(`not an RSA ${'PRIVATE'} KEY`)).not.toContain(`${'PRIVATE'} KEY`);
  });

  it('serialises errors with their cause and redacts inside them', () => {
    const error = new Error(`failed with ${PAT_SENTINEL}`, { cause: { authorization: 'x' } });
    const result = redact(error) as Record<string, unknown>;
    expect(result['name']).toBe('Error');
    expect(result['message']).toBe('failed with [redacted]');
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
