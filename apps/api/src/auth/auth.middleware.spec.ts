import { SELF } from 'cloudflare:test';

describe('authMiddleware (placeholder until #8)', () => {
  // `it.fails` passes only while the assertion fails. When #8 lands real verification this test starts to pass,
  // vitest reports it as an unexpected pass, and #8 flips it to a plain `it` together with its own cases.
  it.fails('rejects an /api/v1 request without an Access JWT with 401 (#8 flips this)', async () => {
    const response = await SELF.fetch('http://api.test/api/v1/projects');
    expect(response.status).toBe(401);
  });
});
