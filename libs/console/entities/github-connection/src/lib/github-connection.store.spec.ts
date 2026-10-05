import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { GITHUB_CONNECT_PATH, PROBLEM_TYPE_PREFIX } from '@shared/contracts';
import {
  connectOutcomeOf,
  ExternalNavigation,
  GITHUB_CONNECTION_URL,
  GitHubConnectionStore,
} from './github-connection.store';

const CONNECTED = {
  state: 'connected',
  login: 'geeera',
  connectedAt: '2026-09-28T10:00:00.000Z',
  appName: 'team-console-dev',
};
const NOT_CONNECTED = { state: 'not-connected', ownerLogin: 'geeera', appName: 'team-console-dev' };
const AUTHORIZE = 'https://github.com/login/oauth/authorize?client_id=Iv23&state=ab';

describe('GitHubConnectionStore', () => {
  let store: GitHubConnectionStore;
  let http: HttpTestingController;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assign = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ExternalNavigation, useValue: { assign } },
      ],
    });
    store = TestBed.inject(GitHubConnectionStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function loadWith(body: object): Promise<void> {
    const loading = store.load();
    http.expectOne(GITHUB_CONNECTION_URL).flush(body);
    await loading;
  }

  it('shows the Worker’s state: connected with login, date and app name', async () => {
    expect(store.view()).toBe('loading');
    await loadWith(CONNECTED);

    expect(store.view()).toBe('connected');
    expect(store.login()).toBe('geeera');
    expect(store.connectedAt()).toBe('2026-09-28T10:00:00.000Z');
    expect(store.appName()).toBe('team-console-dev');
  });

  it('not connected before a first connect, with the owner login the console accepts (#89)', async () => {
    await loadWith(NOT_CONNECTED);

    expect(store.view()).toBe('not-connected');
    expect(store.login()).toBeNull();
    expect(store.ownerLogin()).toBe('geeera');
  });

  it('a 403 github-owner-not-connected after showing "connected" reads as lost, and a reconnect clears it', async () => {
    await loadWith(CONNECTED);

    store.noteNotConnected();
    expect(store.view()).toBe('lost');
    expect(store.ownerLogin()).toBe('geeera');

    await loadWith(NOT_CONNECTED);
    expect(store.view()).toBe('lost');

    await loadWith(CONNECTED);
    expect(store.view()).toBe('connected');
  });

  it('a reload that finds the connection gone reads as lost too', async () => {
    await loadWith(CONNECTED);
    await loadWith(NOT_CONNECTED);

    expect(store.view()).toBe('lost');
  });

  it('noteNotConnected before anything was shown connected stays plain not-connected', async () => {
    await loadWith(NOT_CONNECTED);
    store.noteNotConnected();

    expect(store.view()).toBe('not-connected');
  });

  it('a failed first load is an error with the problem; a body of the wrong shape too', async () => {
    const loading = store.load();
    http
      .expectOne(GITHUB_CONNECTION_URL)
      .flush(
        { type: `${PROBLEM_TYPE_PREFIX}github-auth`, title: 'x', status: 503 },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await loading;
    expect(store.view()).toBe('error');
    expect(store.loadProblem()?.slug).toBe('github-auth');

    await loadWith({ state: 'connected', login: 'geeera' });
    expect(store.view()).toBe('error');
  });

  describe('connect()', () => {
    it('navigates to GitHub’s authorize page the Worker returned', async () => {
      const result = store.connect();
      const request = http.expectOne(GITHUB_CONNECT_PATH);
      expect(request.request.method).toBe('POST');
      request.flush({ authorizeUrl: AUTHORIZE });

      await expect(result).resolves.toEqual({ kind: 'navigating' });
      expect(assign).toHaveBeenCalledWith(AUTHORIZE);
    });

    it.each([
      'https://github.com.evil.example/login/oauth/authorize',
      'https://evil.example/login/oauth/authorize',
      'https://github.com/login/oauth/authorized',
      'javascript:alert(1)',
      42,
    ])('refuses %s without navigating', async (authorizeUrl) => {
      const result = store.connect();
      http.expectOne(GITHUB_CONNECT_PATH).flush({ authorizeUrl });

      await expect(result).resolves.toEqual({ kind: 'refused-url' });
      expect(assign).not.toHaveBeenCalled();
    });

    it('a refused start is a failure with the problem, not a navigation', async () => {
      const result = store.connect();
      http
        .expectOne(GITHUB_CONNECT_PATH)
        .flush(
          { type: `${PROBLEM_TYPE_PREFIX}github-auth`, title: 'x', status: 503 },
          { status: 503, statusText: 'Service Unavailable' },
        );

      const outcome = await result;
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' ? outcome.problem.slug : null).toBe('github-auth');
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe('disconnect()', () => {
    beforeEach(async () => {
      await loadWith(CONNECTED);
    });

    it('204 → revoked and not connected (not lost: the owner asked for it)', async () => {
      const result = store.disconnect();
      const request = http.expectOne(GITHUB_CONNECTION_URL);
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });

      await expect(result).resolves.toEqual({ kind: 'revoked' });
      expect(store.view()).toBe('not-connected');
      expect(store.ownerLogin()).toBe('geeera');
    });

    it('200 incomplete → revoke on GitHub with the checked manage URL', async () => {
      const result = store.disconnect();
      http.expectOne(GITHUB_CONNECTION_URL).flush({
        revoked: false,
        action: 'revoke-on-github',
        reason: 'token-rejected',
        manageUrl: 'https://github.com/settings/applications',
      });

      await expect(result).resolves.toEqual({
        kind: 'revoke-on-github',
        manageUrl: 'https://github.com/settings/applications',
      });
    });

    it('a manage URL off github.com is dropped', async () => {
      const result = store.disconnect();
      http.expectOne(GITHUB_CONNECTION_URL).flush({
        revoked: false,
        action: 'revoke-on-github',
        reason: 'no-usable-token',
        manageUrl: 'https://evil.example/',
      });

      await expect(result).resolves.toEqual({ kind: 'revoke-on-github', manageUrl: null });
    });

    it('a refused disconnect throws and keeps the connection as it was', async () => {
      const result = store.disconnect();
      http.expectOne(GITHUB_CONNECTION_URL).flush(null, { status: 502, statusText: 'Bad Gateway' });

      await expect(result).rejects.toBeTruthy();
      expect(store.view()).toBe('connected');
    });
  });
});

describe('connectOutcomeOf', () => {
  it('reads the callback outcomes and the other login of wrong-account', () => {
    expect(connectOutcomeOf('connected', null)).toEqual({ kind: 'connected' });
    expect(connectOutcomeOf('denied', null)).toEqual({ kind: 'denied' });
    expect(connectOutcomeOf('failed', null)).toEqual({ kind: 'failed' });
    expect(connectOutcomeOf('wrong-account', 'octocat')).toEqual({ kind: 'wrong-account', login: 'octocat' });
  });

  it('ignores an unknown outcome and a login that is not a GitHub login', () => {
    expect(connectOutcomeOf('hacked', null)).toBeNull();
    expect(connectOutcomeOf(undefined, null)).toBeNull();
    expect(connectOutcomeOf('wrong-account', '<img src=x>')).toEqual({ kind: 'wrong-account', login: null });
  });
});
