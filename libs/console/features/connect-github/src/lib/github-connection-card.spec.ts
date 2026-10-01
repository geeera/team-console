import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ExternalNavigation,
  GITHUB_CONNECTION_URL,
  GitHubConnectionStore,
} from '@console/entities/github-connection';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Toaster } from '@console/shared/ui';
import { GITHUB_CONNECT_PATH } from '@shared/contracts';
import { GitHubConnectionCard } from './github-connection-card';

const CONNECTED = {
  state: 'connected',
  login: 'geeera',
  connectedAt: '2026-09-28T10:00:00.000Z',
  appName: 'team-console-dev',
};
const NONE = { state: 'not-connected', ownerLogin: 'geeera', appName: 'team-console-dev' };

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}

describe('GitHubConnectionCard', () => {
  let fixture: ComponentFixture<GitHubConnectionCard>;
  let http: HttpTestingController;
  let root: HTMLElement;
  let assign: ReturnType<typeof vi.fn>;

  async function render(connection: object): Promise<void> {
    assign = vi.fn();
    TestBed.configureTestingModule({
      imports: [GitHubConnectionCard],
      providers: [
        provideConsoleI18n(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: NetworkStatus, useValue: { online: signal(true) } },
        { provide: ExternalNavigation, useValue: { assign } },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GitHubConnectionCard);
    root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await settle();
    expect(root.querySelector('[data-testid="gh-loading"]')?.getAttribute('aria-busy')).toBe('true');
    http.expectOne(GITHUB_CONNECTION_URL).flush(connection);
    await settle();
  }

  const overlay = (): HTMLElement => document.querySelector('.cdk-overlay-container') as HTMLElement;

  afterEach(() => {
    root?.remove();
    overlay()?.remove();
    http.verify();
  });

  it('connected: "Connected as {login}" from the Worker, the date and the app', async () => {
    await render(CONNECTED);

    expect(root.querySelector('[data-testid="gh-connected"] h3')?.textContent?.trim()).toBe(
      'Подключено как geeera',
    );
    expect(root.textContent).toContain('С 28 сентября · приложение team-console-dev');
    expect(root.querySelector('.gh__disconnect')?.getAttribute('aria-label')).toBe(
      'Отключить аккаунт GitHub geeera',
    );
  });

  it('Connect leaves only for GitHub’s authorize page', async () => {
    await render(NONE);
    (root.querySelector('tc-connect-github-button button') as HTMLButtonElement).click();
    await settle();
    http
      .expectOne(GITHUB_CONNECT_PATH)
      .flush({ authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=x&state=y' });
    await settle();

    expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?client_id=x&state=y');
    expect(root.querySelector('tc-connect-github-button button')?.textContent?.trim()).toBe(
      'Открываем GitHub…',
    );
  });

  it('any other address → the error block, no navigation', async () => {
    await render(NONE);
    (root.querySelector('tc-connect-github-button button') as HTMLButtonElement).click();
    await settle();
    http
      .expectOne(GITHUB_CONNECT_PATH)
      .flush({ authorizeUrl: 'https://github.com.evil.example/login/oauth/authorize' });
    await settle();

    expect(assign).not.toHaveBeenCalled();
    const error = root.querySelector('[data-testid="gh-error"]') as HTMLElement;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('Консоль вернула неожиданный адрес для входа');
    expect(document.activeElement).toBe(error.querySelector('h3'));
  });

  it('a connection lost while showing "connected" is a warning with Connect again', async () => {
    await render(CONNECTED);
    TestBed.inject(GitHubConnectionStore).noteNotConnected();
    await settle();

    expect(root.querySelector('[data-testid="gh-lost"] h3')?.textContent?.trim()).toBe(
      'Подключение к GitHub потеряно',
    );
    expect(root.querySelector('[data-testid="gh-lost"] tc-connect-github-button')).not.toBeNull();
    expect(root.querySelector('[data-testid="gh-error"]')).toBeNull();
  });

  it('after the callback, the login shown is the one the Worker reports', async () => {
    await render(NONE);
    fixture.componentRef.setInput('outcome', { kind: 'connected' });
    await settle();
    http.expectOne(GITHUB_CONNECTION_URL).flush(CONNECTED);
    await settle();

    expect(root.querySelector('[data-testid="gh-connected"] h3')?.textContent?.trim()).toBe(
      'Подключено как geeera',
    );
  });

  it('Disconnect asks first, then ends the connection with a toast', async () => {
    await render(CONNECTED);
    (root.querySelector('.gh__disconnect') as HTMLButtonElement).click();
    await settle();
    expect(document.activeElement?.classList).toContain('tc-confirm__cancel');
    (overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement).click();
    await settle();
    const request = http.expectOne(GITHUB_CONNECTION_URL);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await settle();

    expect(root.querySelector('[data-testid="gh-none"]')).not.toBeNull();
    expect(TestBed.inject(Toaster).message()).toBe('GitHub отключён');
  });

  it('ignores a stale failure outcome once the Worker says the connection is already live (#124 item 1)', async () => {
    assign = vi.fn();
    TestBed.configureTestingModule({
      imports: [GitHubConnectionCard],
      providers: [
        provideConsoleI18n(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: NetworkStatus, useValue: { online: signal(true) } },
        { provide: ExternalNavigation, useValue: { assign } },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GitHubConnectionCard);
    fixture.componentRef.setInput('outcome', { kind: 'failed' });
    root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await settle();
    http.expectOne(GITHUB_CONNECTION_URL).flush(CONNECTED);
    await settle();

    expect(root.querySelector('[data-testid="gh-error"]')).toBeNull();
    expect(root.querySelector('[data-testid="gh-connected"] h3')?.textContent?.trim()).toBe(
      'Подключено как geeera',
    );
  });

  it('an unreadable login on wrong-account reads as "a different account", not "?" (#124 item 2)', async () => {
    await render(NONE);
    fixture.componentRef.setInput('outcome', { kind: 'wrong-account', login: null });
    await settle();

    const body = root.querySelector('[data-testid="gh-error"] .gh__body');
    expect(body?.textContent).not.toContain('?');
    expect(body?.textContent).toContain('был выбран другой аккаунт');
  });

  it('a disconnect GitHub did not confirm tells the owner to revoke it there', async () => {
    await render(CONNECTED);
    (root.querySelector('.gh__disconnect') as HTMLButtonElement).click();
    await settle();
    (overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement).click();
    await settle();
    http.expectOne(GITHUB_CONNECTION_URL).flush({
      revoked: false,
      action: 'revoke-on-github',
      reason: 'token-rejected',
      manageUrl: 'https://github.com/settings/applications',
    });
    await settle();

    const note = root.querySelector('.gh__incomplete') as HTMLElement;
    expect(note.textContent).toContain('Отзовите его сами в настройках GitHub');
    expect(note.querySelector('a')?.getAttribute('href')).toBe('https://github.com/settings/applications');
  });
});
