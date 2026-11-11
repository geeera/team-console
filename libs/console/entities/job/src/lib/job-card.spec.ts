import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { JobDto, JobEventDto } from '@shared/contracts';
import { JOB_CARD_EVENTS_SHOWN, JobCard } from './job-card';
import { jobEventFixture, jobFixture, queuedJobFixture } from './job.fixture';

@Component({
  imports: [JobCard],
  template: `<tc-job-card
    [job]="job()"
    [runnerName]="runner()"
    [events]="events()"
    [eventsFailed]="failed()"
  />`,
})
class Host {
  readonly job = signal<JobDto>(jobFixture());
  readonly runner = signal('E2E Mac');
  readonly events = signal<readonly JobEventDto[]>([]);
  readonly failed = signal(false);
}

describe('JobCard', () => {
  function render(change: (host: Host) => void = () => undefined): HTMLElement {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideConsoleI18n()] });
    const fixture = TestBed.createComponent(Host);
    change(fixture.componentInstance);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const text = (root: HTMLElement, id: string): string =>
    root.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? '';

  it('names the kind, the state and the runner that holds the job, labelled by its heading', () => {
    const root = render();
    const card = root.querySelector('[data-testid="job-card"]') as HTMLElement;
    const heading = root.querySelector(`#${card.getAttribute('aria-labelledby') ?? ''}`);
    expect(heading?.textContent?.trim()).toBe('Слот разработки');
    expect(card.dataset['state']).toBe('running');
    expect(text(root, 'job-state')).toBe('Выполняется');
    expect(text(root, 'job-runner')).toBe('E2E Mac');
    expect(text(root, 'job-events-none')).toContain('ещё не прислал');
  });

  it('says a queued job waits for a runner', () => {
    const root = render((host) => host.job.set(queuedJobFixture()));
    expect(text(root, 'job-state')).toBe('В очереди');
    expect(text(root, 'job-runner')).toBe('Ждёт свободного раннера');
    expect(root.querySelector('[data-testid="job-events-none"]')).toBeNull();
  });

  it('shows the tail of the events as plain text, never as markup', () => {
    const many = Array.from({ length: JOB_CARD_EVENTS_SHOWN + 3 }, (_, index) => jobEventFixture(index + 1));
    const root = render((host) =>
      host.events.set([
        ...many,
        jobEventFixture(99, {
          level: 'error',
          kind: 'failed',
          payload: { message: '<img src=x onerror=alert(1)>' },
        }),
      ]),
    );
    const rows = root.querySelectorAll('[data-testid="job-event"]');
    expect(rows).toHaveLength(JOB_CARD_EVENTS_SHOWN);
    const last = rows[rows.length - 1] as HTMLElement;
    expect(last.dataset['kind']).toBe('failed');
    expect(last.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(last.textContent).toContain('Ошибка');
    expect(root.querySelector('img')).toBeNull();
  });

  it("shows an ended job's summary and says when the events could not be refreshed", () => {
    const root = render((host) => {
      host.job.set(
        jobFixture({
          state: 'finished',
          finishedAt: '2026-11-11T09:30:00.000Z',
          result: { summary: 'Merged' },
        }),
      );
      host.failed.set(true);
    });
    expect(text(root, 'job-state')).toBe('Завершён');
    expect(text(root, 'job-summary')).toBe('Merged');
    expect(text(root, 'job-events-failed')).toContain('Не удалось обновить события');
  });
});
