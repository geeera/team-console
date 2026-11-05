import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import { memoryPersistedStateStorage, PERSISTED_STATE_STORAGE } from '@console/shared/persisted-state';
import type { ItemDto } from '@shared/contracts';
import { TaskScreen } from './task-screen';

const BASE = '/api/v1/projects/team-console';
const ITEM: ItemDto = {
  key: 'TC-7',
  number: 7,
  kind: 'bug',
  status: 'approved',
  severity: null,
  tier: 'standard',
  sprint: 3,
  title: 'Answer not saved on a slow network',
  body: 'Repro steps',
  labels: [],
  flags: ['mobile'],
  state: 'open',
  closedAt: null,
  closedReason: null,
  createdBy: { kind: 'job', name: 'pm' },
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  version: 2,
  source: 'import',
  sourceUrl: 'https://github.com/geeera/team-console/issues/7',
};
const SPRINTS = {
  sprints: [
    {
      number: 3,
      title: 'Sprint 03',
      dueOn: '2026-11-13',
      state: 'open',
      description: '',
      createdAt: 'x',
      closedAt: null,
    },
  ],
};

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

function setup(online = true) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideConsoleI18n(),
      provideRouter([]),
      { provide: PERSISTED_STATE_STORAGE, useValue: memoryPersistedStateStorage() },
      { provide: NetworkStatus, useValue: { online: signal(online) } },
    ],
  });
  const fixture = TestBed.createComponent(TaskScreen);
  fixture.componentRef.setInput('slug', 'team-console');
  fixture.componentRef.setInput('number', 7);
  fixture.componentRef.setInput('projectName', 'team-console');
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, http: TestBed.inject(HttpTestingController) };
}

async function answerLoad(http: HttpTestingController, item: ItemDto | null): Promise<void> {
  const read = http.expectOne(`${BASE}/items/7`);
  if (item === null) {
    read.flush({ type: 'x', title: 'x', status: 404 }, { status: 404, statusText: 'Not Found' });
  } else {
    read.flush(item);
  }
  http.expectOne(`${BASE}/sprints`).flush(SPRINTS);
  await settle();
  if (item === null) {
    return;
  }
  http.expectOne((r) => r.url === `${BASE}/items/7/events`).flush({ events: [], next: null });
  http
    .expectOne((r) => r.url === `${BASE}/items/7/comments`)
    .flush({
      comments: [
        {
          id: 1,
          kind: 'comment',
          author: { kind: 'job', name: 'dev' },
          body: 'Repro on 3G',
          createdAt: '2026-11-02T10:00:00Z',
          source: 'console',
          sourceUrl: null,
        },
      ],
      next: null,
    });
  http.expectOne((r) => r.url === `${BASE}/items/7/decisions`).flush({ decisions: [], next: null });
  http
    .expectOne((r) => r.url === `${BASE}/items` && r.params.get('status') === 'approved')
    .flush({
      items: [{ ...item, number: 3, key: 'TC-3' }],
      next: null,
    });
  await settle();
}

describe('TaskScreen', () => {
  it('shows the task: h1, ledger with pickers, the old GitHub link, details and history', async () => {
    const { fixture, root, http } = setup();
    expect(root.textContent).toContain('Загружаем задачу…');
    await answerLoad(http, ITEM);
    fixture.detectChanges();
    expect(root.querySelector('h1')?.textContent?.trim()).toBe(ITEM.title);
    expect(root.querySelector('[data-testid="pick-status"]')?.getAttribute('aria-label')).toBe(
      'Статус: Одобрено',
    );
    expect(root.querySelector('[data-testid="pick-kind"]')?.getAttribute('aria-label')).toBe('Тип: Ошибка');
    expect(root.querySelector('[data-testid="task-sprint"]')?.textContent).toContain('Sprint 03 — текущий');
    expect(root.querySelector('[data-testid="task-queue"]')?.textContent).toContain('2-я из 2 в «Одобрено»');
    expect(
      root.querySelector('a[href="https://github.com/geeera/team-console/issues/7"]')?.textContent,
    ).toContain('#7');
    expect(root.querySelector('[data-testid="task-history"]')?.textContent).toContain('Repro on 3G');
    expect(root.querySelector('[data-testid="comment-field"]')).not.toBeNull();
  });

  it('says there is no such task and links the board', async () => {
    const { fixture, root, http } = setup();
    await answerLoad(http, null);
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="task-not-found"] h1')?.textContent).toContain(
      'Задачи #7 нет в team-console',
    );
  });

  it('offline after load keeps the task and turns every write off with the reason', async () => {
    const { fixture, root, http } = setup(false);
    await answerLoad(http, ITEM);
    fixture.detectChanges();
    expect(root.querySelector('#tc-task-off')?.textContent).toContain('Нет сети');
    for (const selector of [
      '[data-testid="item-edit"]',
      '[data-testid="pick-status"]',
      '[data-testid="comment-send"]',
    ]) {
      const control = root.querySelector(selector);
      expect(control?.getAttribute('aria-disabled')).toBe('true');
      expect(control?.getAttribute('aria-describedby')).toContain('tc-task-off');
    }
  });
});
