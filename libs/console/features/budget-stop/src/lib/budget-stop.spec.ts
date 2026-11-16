import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { QuestionBudgetStop } from '@console/entities/question';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import { Toaster } from '@console/shared/ui';
import { TEAM_CONFIG_SCHEMA } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { BudgetStop, budgetInputErrorOf, budgetMoneyOf, budgetMonthOf } from './budget-stop';
import { teamConfigUrl, teamResumeUrl } from './budget-stop.client';

const STOP: QuestionBudgetStop = {
  project: { slug: 'acme', name: 'Acme' },
  month: '2026-11',
  spentUsd: 201.5,
  budgetUsd: 200,
  stoppedAt: '2026-11-16T10:00:00.000Z',
};

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}

const overlay = (): HTMLElement => document.querySelector('.cdk-overlay-container') as HTMLElement;
const confirmButton = (): HTMLButtonElement =>
  overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement;

describe('budget figures', () => {
  it('words money and the month in the language', () => {
    expect(budgetMoneyOf(200, 'en')).toBe('$200');
    expect(budgetMoneyOf(201.5, 'en')).toBe('$201.50');
    expect(budgetMoneyOf(200, 'ru').replace(/\s/g, ' ')).toBe('200 $');
    expect(budgetMonthOf('2026-11', 'en')).toBe('November');
    expect(budgetMonthOf('2026-11', 'ru')).toBe('ноябрь');
    expect(budgetMonthOf('not-a-month', 'en')).toBe('not-a-month');
  });

  it('takes whole dollars inside the bound and above what was spent', () => {
    expect(budgetInputErrorOf('250', 201.5)).toBeNull();
    expect(budgetInputErrorOf('201', 201.5)?.key).toBe('budget.raise.tooLow');
    expect(budgetInputErrorOf('0', 0)?.key).toBe('budget.raise.invalid');
    expect(budgetInputErrorOf('12.5', 0)?.key).toBe('budget.raise.invalid');
    expect(budgetInputErrorOf('100001', 0)?.key).toBe('budget.raise.invalid');
    expect(budgetInputErrorOf('1e3', 0)?.key).toBe('budget.raise.invalid');
  });
});

describe('BudgetStop', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<BudgetStop>;
  let resolved: number;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideConsoleI18n(), provideHttpClient(), provideHttpClientTesting()],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(BudgetStop);
    fixture.componentRef.setInput('stop', STOP);
    resolved = 0;
    fixture.componentInstance.resolved.subscribe(() => (resolved += 1));
    await fixture.whenStable();
  });

  afterEach(() => {
    overlay()?.remove();
    http.verify();
  });

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const button = (testId: string): HTMLButtonElement =>
    host().querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement;

  it('shows the ru reference copy with the figures, as a labelled region with two actions', () => {
    const region = host().querySelector('[data-testid="budget-stop"]') as HTMLElement;
    const title = region.querySelector('h2') as HTMLElement;
    expect(title.textContent?.trim()).toBe('Бюджет исчерпан — Acme');
    expect(region.getAttribute('aria-labelledby')).toBe(title.id);
    expect(host().querySelector('[data-testid="budget-stop-body"]')?.textContent?.trim().replace(/\s/g, ' ')).toBe(
      'Команда остановилась: потрачено 201,50 $ из 200 $ за ноябрь (оценка Claude Code). Идущие задачи завершены, новые не начнутся.',
    );
    expect(button('budget-resume').textContent?.trim()).toBe('Возобновить на этот месяц');
    expect(button('budget-raise').textContent?.trim()).toBe('Увеличить бюджет');
    expect(button('budget-resume').type).toBe('button');
  });

  it('switches to the en copy', async () => {
    const transloco = TestBed.inject(TranslocoService);
    await firstValueFrom(transloco.load('en'));
    transloco.setActiveLang('en');
    await settle();
    fixture.detectChanges();
    expect(host().querySelector('h2')?.textContent?.trim()).toBe('Budget used up — Acme');
    expect(host().querySelector('[data-testid="budget-stop-body"]')?.textContent?.trim()).toBe(
      'The team stopped: $201.50 of $200 spent in November (Claude Code estimate). Running jobs finished; nothing new starts.',
    );
  });

  it('Resume this month asks “Spending may exceed {budget}.” first, then resumes and says so', async () => {
    button('budget-resume').click();
    await settle();
    expect(overlay().querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(overlay().textContent?.replace(/\s/g, ' ')).toContain('Расходы могут превысить 200 $.');
    confirmButton().click();
    await settle();
    const request = http.expectOne(teamResumeUrl('acme'));
    expect(request.request.method).toBe('POST');
    // Only this row waives the month, and only after its confirm (#733).
    expect(request.request.body).toEqual({ waiveBudget: true });
    request.flush(
      { paused: false, pausedAt: null, pausedBy: null, failedStreak: 0 },
      { status: 201, statusText: 'Created' },
    );
    await settle();
    expect(TestBed.inject(Toaster).message()).toBe('Команда возобновила работу.');
    expect(resolved).toBe(1);
  });

  it('Resume this month backed out sends nothing', async () => {
    button('budget-resume').click();
    await settle();
    (overlay().querySelector('.tc-confirm__cancel') as HTMLButtonElement).click();
    await settle();
    http.expectNone(teamResumeUrl('acme'));
    expect(resolved).toBe(0);
  });

  it('a member’s resume (403) keeps the dialog open with the reason', async () => {
    button('budget-resume').click();
    await settle();
    confirmButton().click();
    await settle();
    http
      .expectOne(teamResumeUrl('acme'))
      .flush(
        { type: 'https://team-console.dev/problems/owner-only', title: 'Forbidden', status: 403 },
        { status: 403, statusText: 'Forbidden' },
      );
    await settle();
    expect(overlay().querySelector('[role="alert"]')?.textContent).toContain(
      'Это может сделать только владелец проекта.',
    );
    expect(resolved).toBe(0);
  });

  it('Raise budget states the overshoot bound, refuses a budget at the spend, and saves over the revision it read', async () => {
    button('budget-raise').click();
    await settle();
    expect(overlay().textContent).toContain('Перерасход ограничен задачами, которые уже идут');
    expect(overlay().textContent).toContain('жёсткий лимит — лимит рабочего пространства Anthropic');
    const field = overlay().querySelector('input') as HTMLInputElement;
    expect(field.value).toBe('200');
    field.value = '201';
    field.dispatchEvent(new Event('input'));
    await settle();
    confirmButton().click();
    await settle();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    http.expectNone(teamConfigUrl('acme'));

    field.value = '300';
    field.dispatchEvent(new Event('input'));
    await settle();
    confirmButton().click();
    await settle();
    http
      .expectOne((request) => request.method === 'GET' && request.url === teamConfigUrl('acme'))
      .flush({
        config: { schema: TEAM_CONFIG_SCHEMA, preset: 'economy', budget: { monthly_usd: 200 } },
        revision: 4,
      });
    await settle();
    const save = http.expectOne(
      (request) => request.method === 'PUT' && request.url === teamConfigUrl('acme'),
    );
    expect(save.request.headers.get('If-Match')).toBe('"4"');
    expect(save.request.body).toEqual({
      config: { schema: TEAM_CONFIG_SCHEMA, preset: 'economy', budget: { monthly_usd: 300 } },
    });
    save.flush({});
    await settle();
    expect(TestBed.inject(Toaster).message()).toBe('Команда возобновила работу.');
    expect(resolved).toBe(1);
  });

  it('Raise budget on a stale revision (412) says so and Try again reads it again', async () => {
    button('budget-raise').click();
    await settle();
    confirmButton().click();
    await settle();
    // The field opens with the current budget, which is not above the spend: raise it first.
    const field = overlay().querySelector('input') as HTMLInputElement;
    field.value = '250';
    field.dispatchEvent(new Event('input'));
    await settle();
    confirmButton().click();
    await settle();
    http.expectOne((request) => request.method === 'GET').flush({ config: null, revision: 0 });
    await settle();
    http
      .expectOne((request) => request.method === 'PUT')
      .flush(
        {
          type: 'https://team-console.dev/problems/team-config-stale',
          title: 'Precondition failed',
          status: 412,
        },
        { status: 412, statusText: 'Precondition Failed' },
      );
    await settle();
    expect(overlay().querySelector('[role="alert"]')?.textContent).toContain(
      'Настройки команды только что изменились.',
    );
    confirmButton().click();
    await settle();
    http.expectOne((request) => request.method === 'GET').flush({ config: null, revision: 1 });
    await settle();
    const retry = http.expectOne((request) => request.method === 'PUT');
    expect(retry.request.headers.get('If-Match')).toBe('"1"');
    expect(retry.request.body).toEqual({
      config: { schema: TEAM_CONFIG_SCHEMA, budget: { monthly_usd: 250 } },
    });
    retry.flush({});
    await settle();
    expect(resolved).toBe(1);
  });
});
