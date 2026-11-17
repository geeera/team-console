import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import {
  NEVER_OFF_ROLES,
  TEAM_CONFIG_SCHEMA,
  type TeamConfig,
  type TeamConfigDto,
  type TeamStatusDto,
} from '@shared/contracts';
import { teamStatusUrl, teamResumeUrl } from '@console/entities/team-run';
import { teamConfigUrlOf } from '../team-config.client';
import { teamConfigViewOf, teamStatusOf } from '../testing';
import { TeamConfigEditor } from './team-config-editor';

const URL = teamConfigUrlOf('acme');
const stored: TeamConfig = {
  schema: TEAM_CONFIG_SCHEMA,
  access: { source: 'api_key' },
  roles: { qa: { model: 'claude-sonnet-5', effort: 'medium' } },
};

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
}

const overlay = (): HTMLElement => document.querySelector('.cdk-overlay-container') as HTMLElement;

async function open(view: TeamConfigDto, status: TeamStatusDto | null = null, focus: string | null = null): Promise<{
  fixture: ComponentFixture<TeamConfigEditor>;
  http: HttpTestingController;
  el: HTMLElement;
  t: (key: string, params?: Record<string, unknown>) => string;
}> {
  TestBed.configureTestingModule({
    providers: [provideConsoleI18n(), provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(TeamConfigEditor);
  fixture.componentRef.setInput('slug', 'acme');
  fixture.componentRef.setInput('projectName', 'Acme');
  fixture.componentRef.setInput('focus', focus);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  const statusRequest = http.expectOne(teamStatusUrl('acme'));
  if (status === null) {
    statusRequest.flush('x', { status: 500, statusText: 'x' });
  } else {
    statusRequest.flush(status);
  }
  http.expectOne(URL).flush(view);
  await settle(fixture);
  const transloco = TestBed.inject(TranslocoService);
  return { fixture, http, el: fixture.nativeElement as HTMLElement, t: (key, params) => transloco.translate(key, params) };
}

const testId = (el: HTMLElement, id: string): HTMLElement | null => el.querySelector(`[data-testid="${id}"]`);

describe('TeamConfigEditor', () => {
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((node) => (node.innerHTML = '')));

  it('locks the five never-off roles with their reason and gives security no switch', async () => {
    const { el, t } = await open(teamConfigViewOf(stored));
    for (const role of NEVER_OFF_ROLES) {
      const row = testId(el, `role-${role}`) as HTMLElement;
      const toggle = row.querySelector('[role="switch"]') as HTMLElement;
      expect(toggle.getAttribute('aria-disabled')).toBe('true');
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      const reason = document.getElementById(toggle.getAttribute('aria-describedby') ?? '');
      expect(reason?.textContent).toContain(t('teamConfig.role.locked'));
    }
    const security = testId(el, 'role-security') as HTMLElement;
    expect(security.querySelector('[role="switch"]')).toBeNull();
    expect(security.textContent).toContain(t('teamConfig.role.security'));
  });

  it('marks an overridden role and counts it in the preset line', async () => {
    const { el, t } = await open(teamConfigViewOf(stored));
    expect(testId(testId(el, 'role-qa') as HTMLElement, 'role-override')?.textContent).toContain(t('teamConfig.role.override'));
    expect(testId(el, 'role-dev')?.querySelector('[data-testid="role-override"]')).toBeNull();
    expect(testId(el, 'preset-line')?.textContent).toContain('1');
  });

  it('shows a member every value as text: no switch, no input, no save bar, the read-only note', async () => {
    const { el, t } = await open(teamConfigViewOf(stored, { canManage: false }));
    expect(el.querySelectorAll('[role="switch"], input, textarea, button[tc-picker]').length).toBe(0);
    expect(testId(el, 'team-read-only')?.textContent).toContain(t('teamConfig.readOnly'));
    expect(testId(el, 'save-bar')).toBeNull();
    expect(testId(testId(el, 'role-qa') as HTMLElement, 'role-model')?.textContent).toContain('Sonnet 5');
  });

  it('says why the subscription is off while a hosted runner can reach the project', async () => {
    const { el, t } = await open(teamConfigViewOf(stored, { subscriptionBlocked: true }));
    const radio = testId(el, 'access-subscription') as HTMLInputElement;
    expect(radio.closest('label')?.getAttribute('aria-disabled') ?? radio.getAttribute('aria-disabled')).toBe('true');
    expect(radio.getAttribute('aria-describedby')).toContain('-blocked');
    expect(testId(el, 'access-blocked')?.textContent).toContain(t('teamConfig.access.blocked'));
    expect(testId(el, 'access-runners')).not.toBeNull();
  });

  it('shows the Batch API off with its reason and the unsupported status (#689)', async () => {
    const { el, t } = await open(teamConfigViewOf(stored));
    const toggle = testId(el, 'cost-batch-api') as HTMLElement;
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(testId(el, 'cost-batch-reason')?.textContent).toContain(t('teamConfig.rules.cost.batchReason'));
    expect(testId(el, 'cost-batch-status')?.textContent).toContain(t('teamConfig.rules.cost.batchStatus'));
  });

  it('offers the suggested budget as a hint and never fills it in', async () => {
    const { el } = await open(teamConfigViewOf({ schema: TEAM_CONFIG_SCHEMA, preset: 'recommended' }));
    const field = testId(el, 'input-budget.monthly_usd') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(el.textContent?.replace(/\s/g, ' ')).toContain('700 $');
  });

  it('counts an edit in the save bar and saves it through the review, focusing the title', async () => {
    const { fixture, el, http, t } = await open(teamConfigViewOf(stored, { revision: 4 }));
    const field = testId(el, 'input-budget.monthly_usd') as HTMLInputElement;
    field.value = '250';
    field.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(testId(el, 'save-bar-count')?.textContent).toContain('1');
    (testId(el, 'save-bar-review') as HTMLButtonElement).click();
    await settle(fixture);
    expect(overlay().querySelector('[data-testid="changes-table"]')?.textContent?.replace(/\s/g, ' ')).toContain('250 $');
    (overlay().querySelector('[data-testid="review-save"]') as HTMLButtonElement).click();
    await settle(fixture);
    const request = http.expectOne((req) => req.method === 'PUT');
    expect(request.request.headers.get('If-Match')).toBe('"4"');
    request.flush(teamConfigViewOf({ ...stored, budget: { monthly_usd: 250 } }, { revision: 5 }));
    await settle(fixture);
    expect(testId(el, 'save-bar')).toBeNull();
    expect(testId(el, 'team-revision')?.textContent).toContain('5');
    expect(document.activeElement).toBe(testId(el, 'team-title'));
    expect(t('teamConfig.saved', { n: 5 })).toContain('5');
  });

  it('blocks the review while a typed value is out of range, saying why', async () => {
    const { fixture, el, t } = await open(teamConfigViewOf(stored));
    const field = testId(el, 'input-sprint.length_days') as HTMLInputElement;
    field.value = '99';
    field.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(testId(el, 'save-bar-review')?.getAttribute('aria-disabled')).toBe('true');
    expect(testId(el, 'save-bar-reason')?.textContent).toContain(t('teamConfig.bar.invalid'));
  });

  it('shows the current reason as text beside the revision, Import and History to the owner, History alone to a member', async () => {
    const reason = '<img src=x onerror="alert(1)"> raised QA turns';
    const owner = await open(teamConfigViewOf(stored, { revision: 12, reason, updatedByName: 'anna' }));
    expect(testId(owner.el, 'team-revision-reason')?.textContent).toBe(reason);
    expect(owner.el.querySelector('img')).toBeNull();
    expect(testId(owner.el, 'team-import')?.textContent).toContain(owner.t('teamConfig.import.title'));
    expect(testId(owner.el, 'team-history')).not.toBeNull();
    TestBed.resetTestingModule();
    const member = await open(teamConfigViewOf(stored, { canManage: false }));
    expect(testId(member.el, 'team-import')).toBeNull();
    expect(testId(member.el, 'team-history')).not.toBeNull();
  });

  it('shows Budget used up with the figures; Raise budget unfolds Limits and focuses the budget', async () => {
    const status = teamStatusOf({
      state: 'paused-by-budget',
      budget: { month: '2026-11', spentUsd: 200, budgetUsd: 200, waivedAt: null },
    });
    const { el, t, fixture } = await open(teamConfigViewOf({ ...stored, budget: { monthly_usd: 200 } }), status);
    const callout = testId(el, 'team-budget-stop') as HTMLElement;
    expect(callout.querySelector('h2')?.textContent).toContain(t('teamConfig.budget.title'));
    expect(testId(callout, 'team-budget-body')?.textContent?.replace(/\s/g, ' ')).toContain('потрачено 200 $ из 200 $');
    testId(callout, 'team-budget-raise')?.click();
    await settle(fixture);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('input-budget.monthly_usd');
  });

  it('Resume this month asks the one line first and resumes through the shared action', async () => {
    const status = teamStatusOf({
      state: 'paused-by-budget',
      budget: { month: '2026-11', spentUsd: 200, budgetUsd: 200, waivedAt: null },
    });
    const { el, http, fixture } = await open(teamConfigViewOf(stored), status);
    testId(el, 'team-budget-resume')?.click();
    await settle(fixture);
    expect(overlay().textContent?.replace(/\s/g, ' ')).toContain('Расходы могут превысить 200 $.');
    (overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement).click();
    await settle(fixture);
    const resume = http.expectOne(teamResumeUrl('acme'));
    expect(resume.request.body).toEqual({ waiveBudget: true });
    resume.flush({});
    await settle(fixture);
    http.expectOne(teamStatusUrl('acme')).flush(teamStatusOf());
    await settle(fixture);
    expect(testId(el, 'team-budget-stop')).toBeNull();
  });

  it('a member sees the stop without its actions', async () => {
    const status = teamStatusOf({
      state: 'paused-by-budget',
      budget: { month: '2026-11', spentUsd: 200, budgetUsd: 200, waivedAt: null },
    });
    const { el } = await open(teamConfigViewOf(stored, { canManage: false }), status);
    expect(testId(el, 'team-budget-readonly')).not.toBeNull();
    expect(testId(el, 'team-budget-resume')).toBeNull();
  });

  it('says the month is waived and that a changed budget ends the waiver', async () => {
    const status = teamStatusOf({
      budget: { month: '2026-11', spentUsd: 212, budgetUsd: 200, waivedAt: '2026-11-16T09:00:00.000Z' },
    });
    const { el, t } = await open(teamConfigViewOf(stored), status);
    const waived = testId(el, 'team-waived') as HTMLElement;
    expect(waived.querySelector('h3')?.textContent).toContain('Ноябрь');
    expect(testId(waived, 'team-waived-body')?.textContent).toContain('1 декабря');
    expect(testId(waived, 'team-waived-ends')?.textContent?.trim()).toBe(t('teamConfig.budget.waivedEnds'));
    expect(testId(el, 'team-budget-stop')).toBeNull();
  });

  it('opens at the budget when the link asked for it (?focus=budget)', async () => {
    const { fixture } = await open(teamConfigViewOf(stored), null, 'budget');
    await settle(fixture);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('input-budget.monthly_usd');
  });

  it('while the budget is changed in a waived month, the note says it is capped again and the review row ends the waiver', async () => {
    const status = teamStatusOf({
      budget: { month: '2026-11', spentUsd: 212, budgetUsd: 200, waivedAt: '2026-11-16T09:00:00.000Z' },
    });
    const { el, t, fixture } = await open(teamConfigViewOf({ ...stored, budget: { monthly_usd: 200 } }), status);
    const waived = testId(el, 'team-waived') as HTMLElement;
    expect(waived.getAttribute('data-editing')).toBeNull();
    const field = testId(el, 'input-budget.monthly_usd') as HTMLInputElement;
    field.value = '300';
    field.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(waived.getAttribute('data-editing')).toBe('true');
    expect(testId(waived, 'team-waived-ends')?.textContent?.replace(/\s/g, ' ')).toContain(
      'После сохранения ноябрь снова будет ограничен суммой 300 $.',
    );
    testId(el, 'save-bar-review')?.click();
    await settle(fixture);
    expect(overlay().querySelector('[data-testid="change-note-budget.monthly_usd"]')?.textContent).toBe(
      t('teamConfig.budget.waivedReview', { month: 'ноябрь' }),
    );
  });
});
