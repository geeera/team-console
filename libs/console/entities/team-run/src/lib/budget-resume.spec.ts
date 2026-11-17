import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Toaster } from '@console/shared/ui';
import { PROBLEM_TYPE_PREFIX } from '@shared/contracts';
import { BudgetResume, budgetMoneyOf, budgetMonthOf, teamResumeUrl } from './budget-resume';

const overlay = (): HTMLElement => document.querySelector('.cdk-overlay-container') as HTMLElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function problem(status: number, slug: string): { body: object; init: { status: number; statusText: string } } {
  return { body: { type: `${PROBLEM_TYPE_PREFIX}${slug}`, title: 'x', status }, init: { status, statusText: 'x' } };
}

describe('budget figures', () => {
  it('words money and the UTC month in the language', () => {
    expect(budgetMoneyOf(201.5, 'en')).toBe('$201.50');
    expect(budgetMonthOf('2026-11', 'ru')).toBe('ноябрь');
    expect(budgetMonthOf('not-a-month', 'en')).toBe('not-a-month');
  });
});

describe('BudgetResume (#684, shared with Settings › Team #688)', () => {
  let http: HttpTestingController;
  let resume: BudgetResume;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n(), provideHttpClient(), provideHttpClientTesting()] });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    resume = TestBed.inject(BudgetResume);
  });

  afterEach(() => {
    overlay()?.replaceChildren();
    http.verify();
  });

  it('waives the month with the resume, and takes "not paused" as done', async () => {
    const first = resume.resume('acme');
    const request = http.expectOne(teamResumeUrl('acme'));
    expect(request.request.body).toEqual({ waiveBudget: true });
    request.flush({}, { status: 201, statusText: 'Created' });
    expect(await first).toEqual({ ok: true });
    const again = resume.resume('acme');
    const refused = problem(409, 'team-not-paused');
    http.expectOne(teamResumeUrl('acme')).flush(refused.body, refused.init);
    expect(await again).toEqual({ ok: true });
  });

  it('turns a refusal into its failure, never a throw', async () => {
    const result = resume.resume('acme');
    const refused = problem(403, 'owner-only');
    http.expectOne(teamResumeUrl('acme')).flush(refused.body, refused.init);
    expect(await result).toEqual({ ok: false, failure: 'forbidden' });
  });

  it('asks the one line first; backing out sends nothing', async () => {
    const asked = resume.confirmResume({ slug: 'acme', projectName: 'Acme', budgetUsd: 200 });
    await settle();
    expect(overlay().textContent?.replace(/\s/g, ' ')).toContain('Расходы могут превысить 200 $.');
    (overlay().querySelector('.tc-confirm__cancel') as HTMLButtonElement).click();
    await settle();
    expect(await asked).toBe(false);
    http.expectNone(teamResumeUrl('acme'));
  });

  it('after the confirm resumes and says "Team resumed."', async () => {
    const asked = resume.confirmResume({ slug: 'acme', projectName: 'Acme', budgetUsd: 200 });
    await settle();
    (overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement).click();
    await settle();
    http.expectOne(teamResumeUrl('acme')).flush({}, { status: 201, statusText: 'Created' });
    expect(await asked).toBe(true);
    expect(TestBed.inject(Toaster).message()).toBe('Команда возобновила работу.');
  });
});
