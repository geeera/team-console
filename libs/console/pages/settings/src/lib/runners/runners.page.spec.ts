import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { PROJECTS_URL } from '@console/entities/project';
import {
  RUNNER_FIXTURE_IDS,
  RunnersApi,
  runnerFixture,
  type RunnerResult,
} from '@console/entities/runner';
import { EnrolRunner } from '@console/features/enrol-runner';
import { ManageRunner, type RevokeOutcome } from '@console/features/manage-runner';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  OWNER_ACCOUNT_ID,
  type AccountMembershipDto,
  type RunnerDto,
  type RunnerListDto,
} from '@shared/contracts';
import { settingsRoutes } from '../settings.routes';

const OWNER: AccountMembershipDto = { id: OWNER_ACCOUNT_ID, slug: 'owner', name: 'Owner', role: 'owner' };
const RELEASE = { version: '0.3.0', minimumVersion: '0.2.0' };
const PROJECTS = [
  { slug: 'team-console', repo: 'geeera/team-console', displayName: 'Team Console', routineId: null, addedAt: '2026-10-01T00:00:00.000Z', archivedAt: null },
  { slug: 'storify', repo: 'geeera/storify', displayName: 'Storify', routineId: null, addedAt: '2026-10-01T00:00:00.000Z', archivedAt: null },
];

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}

describe('RunnersPage (/settings/runners, #464)', () => {
  let harness: RouterTestingHarness;

  async function open({
    accounts = { ok: true, value: [OWNER] } as RunnerResult<readonly AccountMembershipDto[]>,
    list = (): RunnerResult<RunnerListDto> => ({ ok: true, value: { runners: [runnerFixture()], release: RELEASE } }),
    revokeOutcome = { kind: 'cancelled' } as RevokeOutcome,
    edited = null as RunnerDto | null,
  } = {}) {
    const api = {
      accounts: vi.fn(async () => accounts),
      list: vi.fn(async () => list()),
      policy: vi.fn(async () => ({ ok: true, value: { policy: null, effective: { mode: 'any' } } })),
      setPolicy: vi.fn(),
    };
    const enrol = { open: vi.fn(async () => true) };
    const manage = { revoke: vi.fn(async () => revokeOutcome), editProjects: vi.fn(async () => edited) };
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'settings', children: settingsRoutes }]),
        { provide: RunnersApi, useValue: api },
        { provide: EnrolRunner, useValue: enrol },
        { provide: ManageRunner, useValue: manage },
      ],
    });
    harness = await RouterTestingHarness.create();
    document.body.appendChild(harness.fixture.nativeElement);
    await harness.navigateByUrl('/settings/runners');
    await settle();
    TestBed.inject(HttpTestingController).match(PROJECTS_URL).forEach((request) => request.flush(PROJECTS));
    await settle();
    const root = harness.routeNativeElement as HTMLElement;
    const find = (id: string): HTMLElement | null => root.querySelector(`[data-testid="${id}"]`);
    return { root, find, api, enrol, manage };
  }

  afterEach(() => {
    harness?.fixture.nativeElement.remove();
  });

  it('shows the runners with their facts, the release, and both placement editors', async () => {
    const { root, find, api } = await open({
      list: () => ({
        ok: true,
        value: {
          runners: [
            runnerFixture({ id: RUNNER_FIXTURE_IDS.old, name: 'Old', revokedAt: '2026-11-01T00:00:00.000Z', online: false }),
            runnerFixture({ version: '0.1.0', belowMinimum: true }),
          ],
          release: RELEASE,
        },
      }),
    });
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Раннеры');
    expect(document.activeElement).toBe(root.querySelector('h1'));
    const cards = [...root.querySelectorAll('[data-testid="runner-card"]')];
    expect(cards.map((card) => card.querySelector('h3')?.textContent?.trim())).toEqual(['Mac', 'Old']);
    expect(cards[0]?.querySelector('[data-testid="runner-behind"]')).not.toBeNull();
    // A revoked runner has no actions left.
    expect(cards[1]?.querySelector('[data-testid="runner-revoke"]')).toBeNull();
    expect(find('runners-release')?.textContent).toContain('0.3.0');
    expect(find('runners-policy-account')?.querySelector('tc-runner-policy-editor')).not.toBeNull();
    expect(api.policy).toHaveBeenCalledWith({ kind: 'account', accountId: OWNER_ACCOUNT_ID });
    expect(api.policy).toHaveBeenCalledWith({ kind: 'project', slug: 'team-console' });
    const picker = find('runners-policy-pick') as HTMLSelectElement;
    expect([...picker.options].map((option) => option.text)).toEqual(['Team Console', 'Storify']);
    picker.value = 'storify';
    picker.dispatchEvent(new Event('change'));
    await settle();
    expect(api.policy).toHaveBeenCalledWith({ kind: 'project', slug: 'storify' });
  });

  it('shows the empty state with the enrolment call to action, which opens enrolment for the account', async () => {
    const { find, enrol, api } = await open({
      list: () => ({ ok: true, value: { runners: [], release: { version: null, minimumVersion: null } } }),
    });
    expect(find('runners-empty')?.textContent).toContain('Раннеров пока нет');
    expect(find('runners-release')).toBeNull();
    const reads = api.list.mock.calls.length;
    (find('runners-empty')?.querySelector('[data-testid="runners-enrol"]') as HTMLButtonElement).click();
    await settle();
    expect(enrol.open).toHaveBeenCalledWith({
      accountId: OWNER_ACCOUNT_ID,
      projects: [
        { slug: 'team-console', displayName: 'Team Console' },
        { slug: 'storify', displayName: 'Storify' },
      ],
    });
    // A code was issued: the list is read again (the runner shows once it has enrolled).
    expect(api.list.mock.calls.length).toBe(reads + 1);
  });

  it('tells a member of the account that the owner manages runners, and reads nothing else', async () => {
    const { find, api } = await open({
      accounts: { ok: true, value: [{ ...OWNER, role: 'member' }] },
    });
    expect(find('runners-forbidden')?.textContent).toContain('Раннерами управляет владелец аккаунта');
    expect(find('runners-forbidden')?.textContent).toContain('Вы участник этого аккаунта, но не владелец.');
    expect(api.list).not.toHaveBeenCalled();
    expect(find('runners-placement')).toBeNull();
  });

  it('shows a failed read with the reason and Try again', async () => {
    let failing = true;
    const { find } = await open({
      list: () =>
        failing
          ? { ok: false, failure: { kind: 'offline', slug: null, field: null } }
          : { ok: true, value: { runners: [], release: RELEASE } },
    });
    expect(find('runners-error')?.textContent).toContain('Не удалось загрузить раннеры');
    expect(find('runners-error')?.textContent).toContain('Нет сети.');
    failing = false;
    (find('runners-error')?.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(find('runners-empty')).not.toBeNull();
  });

  it('applies a revoke in place, leaving the runner without actions', async () => {
    const revoked = runnerFixture({ revokedAt: '2026-11-11T10:00:00.000Z', online: false });
    const { root, find, manage } = await open({ revokeOutcome: { kind: 'revoked', runner: revoked } });
    (find('runner-revoke') as HTMLButtonElement).click();
    await settle();
    expect(manage.revoke).toHaveBeenCalledWith({ accountId: OWNER_ACCOUNT_ID, runner: runnerFixture() });
    expect(root.querySelector('[data-testid="runner-presence"]')?.textContent?.trim()).toBe('Отозван');
    expect(find('runner-revoke')).toBeNull();
  });

  it('applies a changed allow-list in place', async () => {
    const { find, manage } = await open({ edited: runnerFixture({ allowedProjects: ['storify'] }) });
    expect(find('runner-edit-projects')?.getAttribute('aria-label')).toBe('Изменить проекты раннера Mac');
    (find('runner-edit-projects') as HTMLButtonElement).click();
    await settle();
    expect(manage.editProjects).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: OWNER_ACCOUNT_ID, runner: runnerFixture() }),
    );
    expect(find('runner-projects')?.textContent?.trim()).toBe('storify');
  });
});
