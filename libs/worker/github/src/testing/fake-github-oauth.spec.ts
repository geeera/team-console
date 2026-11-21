import { FakeGitHubOAuth } from './fake-github-oauth';

const PULLS = 'https://api.github.com/repos/geeera/team-console/pulls?state=open';

function fake(): FakeGitHubOAuth {
  return new FakeGitHubOAuth({ clientId: 'client', clientSecret: 'secret' });
}

describe('FakeGitHubOAuth pulls', () => {
  it('answers 404 for a repository never seeded, so the api mock keeps its list', async () => {
    const response = await fake().fetch(PULLS, { method: 'GET' });
    expect(response.status).toBe(404);
  });

  it('serves the seeded pull requests', async () => {
    const server = fake();
    server.seedPulls('geeera/team-console', [{ number: 177, state: 'open' }]);
    const response = await server.fetch(PULLS, { method: 'GET' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ number: 177, state: 'open' }]);
  });

  it('answers 404 again after clearPulls, whatever the repository case', async () => {
    const server = fake();
    server.seedPulls('geeera/team-console', [{ number: 177, state: 'open' }]);
    server.clearPulls('Geeera/Team-Console');
    const response = await server.fetch(PULLS, { method: 'GET' });
    expect(response.status).toBe(404);
  });

  it('leaves other repositories seeded on clearPulls', async () => {
    const server = fake();
    server.seedPulls('geeera/team-console', [{ number: 177, state: 'open' }]);
    server.seedPulls('geeera/other', [{ number: 1, state: 'open' }]);
    server.clearPulls('geeera/other');
    const response = await server.fetch(PULLS, { method: 'GET' });
    expect(response.status).toBe(200);
  });
});
