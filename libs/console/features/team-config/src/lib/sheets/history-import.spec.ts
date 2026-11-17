import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import { DIALOG_DATA, DialogRef } from '@console/shared/ui';
import {
  TEAM_CONFIG_SCHEMA,
  problemTypeOf,
  type TeamConfigImportDto,
  type TeamConfigRevisionDto,
  type TeamConfigRevisionSummaryDto,
} from '@shared/contracts';
import { teamConfigImportUrlOf, teamConfigRevisionsUrlOf } from '../team-config.client';
import { draftOf } from '../team-draft';
import { teamConfigViewOf } from '../testing';
import { HISTORY_SHOWN_STEP, HistorySheet } from './history-sheet';
import { ImportSheet } from './import-sheet';

const SCRIPT = '<img src=x onerror="alert(1)"> QA on Sonnet';
const REVISIONS = teamConfigRevisionsUrlOf('acme');

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
}

const testId = (el: HTMLElement, id: string): HTMLElement | null => el.querySelector(`[data-testid="${id}"]`);

function summary(revision: number, extras: Partial<TeamConfigRevisionSummaryDto> = {}): TeamConfigRevisionSummaryDto {
  return {
    revision,
    createdAt: '2026-11-14T16:20:00.000Z',
    createdBy: 'local-owner',
    createdByName: null,
    reason: null,
    paths: ['roles.qa.model'],
    ...extras,
  };
}

const revisionNine: TeamConfigRevisionDto = {
  revision: 9,
  config: { schema: TEAM_CONFIG_SCHEMA, access: { source: 'api_key' }, roles: { qa: { model: 'claude-sonnet-5' } } },
  diff: [
    { path: 'roles.qa.model', from: 'claude-opus-5-5', to: 'claude-sonnet-5' },
    { path: 'budget.monthly_usd', to: 200 },
  ],
  createdAt: '2026-11-01T10:02:00.000Z',
  createdBy: 'u1',
  createdByName: 'anna',
  reason: SCRIPT,
};

function setup<T>(component: Type<T>, data: unknown): {
  fixture: ComponentFixture<T>;
  http: HttpTestingController;
  el: HTMLElement;
  close: ReturnType<typeof vi.fn>;
  t: (key: string, params?: Record<string, unknown>) => string;
} {
  const close = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideConsoleI18n(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: DialogRef, useValue: { close, disableClose: false } },
      { provide: DIALOG_DATA, useValue: data },
    ],
  });
  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();
  const transloco = TestBed.inject(TranslocoService);
  return {
    fixture,
    http: TestBed.inject(HttpTestingController),
    el: fixture.nativeElement as HTMLElement,
    close,
    t: (key, params) => transloco.translate(key, params),
  };
}

describe('HistorySheet', () => {
  it('lists revisions newest first with author, settings and the reason as text, never markup (T4)', async () => {
    const { fixture, http, el, t } = setup(HistorySheet, { slug: 'acme', canUseDraft: true });
    http
      .expectOne((req) => req.url === REVISIONS && req.params.get('after') === '0')
      .flush({ revisions: [summary(8), summary(9, { createdByName: 'anna', reason: SCRIPT })], nextCursor: null });
    await settle(fixture);
    const rows = [...el.querySelectorAll('[data-testid^="history-row-"]')];
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(['history-row-9', 'history-row-8']);
    const nine = rows[0] as HTMLElement;
    expect(nine.textContent).toContain('anna');
    expect(nine.textContent).toContain(t('teamConfig.history.settings.one', { n: '1' }));
    expect(testId(nine, 'history-reason')?.textContent?.trim()).toBe(SCRIPT);
    expect(el.querySelector('img')).toBeNull();
    expect(testId(rows[1] as HTMLElement, 'history-reason')?.textContent).toContain(t('teamConfig.history.noReason'));
    expect(rows[1]?.textContent).toContain(t('teamConfig.owner'));
  });

  it('reads every page and shows more on request', async () => {
    const { fixture, http, el } = setup(HistorySheet, { slug: 'acme', canUseDraft: false });
    const first = Array.from({ length: 100 }, (_, at) => summary(at + 1));
    http.expectOne((req) => req.params.get('after') === '0').flush({ revisions: first, nextCursor: 100 });
    await settle(fixture);
    http.expectOne((req) => req.params.get('after') === '100').flush({ revisions: [summary(101)], nextCursor: null });
    await settle(fixture);
    expect(el.querySelectorAll('[data-testid^="history-row-"]').length).toBe(HISTORY_SHOWN_STEP);
    expect(el.querySelector('[data-testid^="history-row-"]')?.getAttribute('data-testid')).toBe('history-row-101');
    testId(el, 'history-more')?.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-testid^="history-row-"]').length).toBe(HISTORY_SHOWN_STEP * 2);
  });

  it('is the partial state when the list fails: its own error and Try again, then the list', async () => {
    const { fixture, http, el, t } = setup(HistorySheet, { slug: 'acme', canUseDraft: true });
    http.expectOne((req) => req.url === REVISIONS).flush('down', { status: 503, statusText: 'x' });
    await settle(fixture);
    expect(testId(el, 'history-error')?.textContent).toContain(t('teamConfig.history.failedTitle'));
    expect(testId(el, 'history-error')?.textContent).toContain(t('teamConfig.history.failed'));
    testId(el, 'history-retry')?.click();
    http.expectOne((req) => req.url === REVISIONS).flush({ revisions: [], nextCursor: null });
    await settle(fixture);
    expect(testId(el, 'history-error')).toBeNull();
    expect(testId(el, 'history-empty')?.textContent).toContain(t('teamConfig.history.empty'));
  });

  it('opens a revision as a diff in words, the reason as text, the raw JSON behind Show raw, and Use as draft', async () => {
    const { fixture, http, el, close, t } = setup(HistorySheet, { slug: 'acme', canUseDraft: true });
    http.expectOne((req) => req.url === REVISIONS).flush({ revisions: [summary(9, { reason: SCRIPT })], nextCursor: null });
    await settle(fixture);
    (testId(el, 'history-row-9')?.querySelector('button') as HTMLButtonElement).click();
    http.expectOne(`${REVISIONS}/9`).flush(revisionNine);
    await settle(fixture);
    expect(testId(el, 'revision')?.querySelector('h3')?.textContent).toContain(t('teamConfig.history.revision', { n: 9 }));
    expect(testId(el, 'revision-meta')?.textContent).toContain('anna');
    expect(testId(el, 'revision-reason')?.textContent?.trim()).toBe(SCRIPT);
    expect(el.querySelector('img')).toBeNull();
    const table = testId(el, 'changes-table') as HTMLElement;
    expect(table.querySelector('[data-path="roles.qa.model"]')?.textContent).toContain('Sonnet 5');
    expect(table.querySelector('[data-path="budget.monthly_usd"]')?.textContent).toContain(
      t('teamConfig.history.notSet'),
    );
    const raw = testId(el, 'revision-raw') as HTMLElement;
    const toggle = testId(el, 'revision-raw-toggle') as HTMLButtonElement;
    expect(raw.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    fixture.detectChanges();
    expect(raw.hidden).toBe(false);
    expect(JSON.parse(raw.textContent ?? '')).toEqual({
      'roles.qa.model': { from: 'claude-opus-5-5', to: 'claude-sonnet-5' },
      'budget.monthly_usd': { to: 200 },
    });
    expect(el.textContent).not.toContain('Restore');
    testId(el, 'revision-use')?.click();
    expect(close).toHaveBeenCalledWith(revisionNine);
  });

  it('gives a member the diff but no Use as draft, and a failed revision its own Try again', async () => {
    const { fixture, http, el } = setup(HistorySheet, { slug: 'acme', canUseDraft: false });
    http.expectOne((req) => req.url === REVISIONS).flush({ revisions: [summary(9)], nextCursor: null });
    await settle(fixture);
    (testId(el, 'history-row-9')?.querySelector('button') as HTMLButtonElement).click();
    http.expectOne(`${REVISIONS}/9`).flush('x', { status: 500, statusText: 'x' });
    await settle(fixture);
    expect(testId(el, 'revision-error')).not.toBeNull();
    testId(el, 'revision-retry')?.click();
    http.expectOne(`${REVISIONS}/9`).flush(revisionNine);
    await settle(fixture);
    expect(testId(el, 'revision')).not.toBeNull();
    expect(testId(el, 'revision-use')).toBeNull();
    testId(el, 'history-back')?.click();
    await settle(fixture);
    expect(testId(el, 'history-row-9')).not.toBeNull();
  });
});

describe('ImportSheet', () => {
  const draft = { ...draftOf(teamConfigViewOf({ schema: TEAM_CONFIG_SCHEMA, access: { source: 'api_key' } })), monthlyUsd: 200 };
  const imported: TeamConfigImportDto = {
    draft: {
      schema: TEAM_CONFIG_SCHEMA,
      preset: 'recommended',
      gates: { qa: 'code', code_paths: ['apps/**', 'libs/**'], max_rework_rounds: 2 },
      language: 'ru',
    },
    notes: [
      { path: 'review.qa', code: 'never-as-code' },
      { path: 'roles.dev.model', code: 'model-ignored' },
      { path: '<b>owner.extra</b>', code: 'key-ignored' },
    ],
    source: { path: '.product-team/project.yml', ref: 'main', sha: 'c'.repeat(40) },
  };

  it('shows what the file changes, its notes and the keys it did not take, and hands back the draft, never saving', async () => {
    const { fixture, http, el, close, t } = setup(ImportSheet, { slug: 'acme', draft });
    const request = http.expectOne(teamConfigImportUrlOf('acme'));
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({});
    request.flush(imported);
    await settle(fixture);
    expect(testId(el, 'import-source')?.textContent).toContain('main');
    const table = testId(el, 'changes-table') as HTMLElement;
    expect(table.querySelector('[data-path="gates.qa"]')?.textContent).toContain(t('teamConfig.rules.gate.code'));
    expect(table.querySelector('[data-path="gates.max_rework_rounds"]')?.textContent).toContain('2');
    expect(table.querySelector('[data-path="budget.monthly_usd"]')).toBeNull();
    expect(testId(el, 'import-notes')?.textContent).toContain(
      t('teamConfig.import.note.never-as-code', { path: 'review.qa' }),
    );
    const ignored = testId(el, 'import-ignored') as HTMLElement;
    expect(ignored.textContent).toContain('roles.dev.model');
    expect(ignored.textContent).toContain('<b>owner.extra</b>');
    expect(ignored.querySelector('b')).toBeNull();
    testId(el, 'import-use')?.click();
    const merged = close.mock.calls[0]?.[0] as typeof draft;
    expect(merged.gates.qa).toBe('code');
    expect(merged.monthlyUsd).toBe(200);
    expect(merged.roles).toEqual(draft.roles);
    http.verify();
  });

  it('says why a failed import gave nothing, and Try again reads the file again', async () => {
    const { fixture, http, el, close, t } = setup(ImportSheet, { slug: 'acme', draft });
    http
      .expectOne(teamConfigImportUrlOf('acme'))
      .flush(
        { type: problemTypeOf('team-config-import-invalid'), title: 'x', status: 422, field: 'project.yml' },
        { status: 422, statusText: 'x' },
      );
    await settle(fixture);
    expect(testId(el, 'import-error')?.textContent).toContain(t('teamConfig.import.failedTitle'));
    expect(testId(el, 'import-error')?.textContent).toContain(t('teamConfig.import.failed.unreadable'));
    expect(testId(el, 'import-use')).toBeNull();
    testId(el, 'import-retry')?.click();
    http.expectOne(teamConfigImportUrlOf('acme')).flush(imported);
    await settle(fixture);
    expect(testId(el, 'import-error')).toBeNull();
    expect(testId(el, 'changes-table')).not.toBeNull();
    testId(el, 'import-cancel')?.click();
    expect(close).toHaveBeenCalledWith();
  });
});
