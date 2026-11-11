import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { queuedJobFixture, RUN_NOW_KINDS } from '@console/entities/job';
import { provideConsoleI18n } from '@console/shared/i18n';
import { problemTypeOf, type JobDto } from '@shared/contracts';
import { RunNow } from './run-now';

const JOBS = '/api/v1/projects/team-console/jobs';

@Component({
  imports: [RunNow],
  template: `<tc-run-now [slug]="slug()" (enqueued)="queued.push($event)" />`,
})
class Host {
  readonly slug = signal('team-console');
  readonly queued: JobDto[] = [];
}

describe('RunNow', () => {
  function setup() {
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideConsoleI18n()],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const select = root.querySelector('[data-testid="run-now-kind"]') as HTMLSelectElement;
    const submit = root.querySelector('[data-testid="run-now-submit"]') as HTMLButtonElement;
    return { fixture, root, select, submit, http: TestBed.inject(HttpTestingController) };
  }

  async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }): Promise<void> {
    for (let index = 0; index < 3; index += 1) {
      await new Promise((done) => setTimeout(done, 0));
      fixture.detectChanges();
    }
    await fixture.whenStable();
  }

  it('offers the Run now kinds under a labelled picker', () => {
    const { root, select } = setup();
    expect([...select.options].map((option) => option.value)).toEqual([...RUN_NOW_KINDS]);
    expect(select.options[1]?.textContent?.trim()).toBe('Слот разработки');
    const label = root.querySelector(`label[for="${select.id}"]`);
    expect(label?.textContent).toContain('Что запустить');
  });

  it('queues the chosen kind, waits while the request is out, and emits the job', async () => {
    const { fixture, root, select, submit, http } = setup();
    select.value = 'slot-qa';
    select.dispatchEvent(new Event('change'));
    submit.click();
    fixture.detectChanges();

    const request = http.expectOne(JOBS);
    expect(request.request.body).toEqual({ kind: 'slot-qa' });
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute('aria-busy')).toBe('true');
    expect(select.disabled).toBe(true);
    // A second press while waiting sends nothing.
    submit.click();
    http.expectNone(JOBS);

    const job = queuedJobFixture({ kind: 'slot-qa' });
    request.flush(job, { status: 201, statusText: 'Created' });
    await settle(fixture);
    expect(submit.disabled).toBe(false);
    expect(fixture.componentInstance.queued).toEqual([job]);
    const outcome = root.querySelector('[data-testid="run-now-outcome"]') as HTMLElement;
    expect(outcome.getAttribute('role')).toBe('status');
    expect(outcome.textContent).toContain('Слот QA: поставлено в очередь.');
  });

  it.each([
    [403, 'owner-only', 'forbidden', 'Запускать задачи может только владелец аккаунта'],
    [404, 'project-not-found', 'not-found', 'Проект не найден'],
    [409, 'job-exists', 'exists', 'уже в очереди или выполняется'],
    [409, 'tracker-not-cut-over', 'not-cut-over', 'ещё ведёт задачи в GitHub Issues'],
    [422, 'job-invalid', 'invalid', 'Консоль не приняла запрос'],
    [429, 'rate-limited', 'rate-limited', 'Слишком много запросов'],
    [500, 'internal', 'error', 'Что-то пошло не так'],
  ])('says why a %s %s was refused and emits nothing', async (status, type, kind, words) => {
    const { fixture, root, submit, http } = setup();
    submit.click();
    http
      .expectOne(JOBS)
      .flush(
        { type: problemTypeOf(type), title: 'x', status },
        { status, statusText: 'x', headers: { 'Content-Type': 'application/problem+json' } },
      );
    await settle(fixture);
    const error = root.querySelector('[data-testid="run-now-error"]') as HTMLElement;
    expect(error.dataset['kind']).toBe(kind);
    expect(error.textContent).toContain(words);
    expect(root.querySelector('[data-testid="run-now-queued"]')).toBeNull();
    expect(fixture.componentInstance.queued).toEqual([]);
    expect(submit.disabled).toBe(false);
  });

  it('says when there is no network', async () => {
    const { fixture, root, submit, http } = setup();
    submit.click();
    http.expectOne(JOBS).error(new ProgressEvent('error'), { status: 0 });
    await settle(fixture);
    expect(root.querySelector('[data-testid="run-now-error"]')?.textContent).toContain('Нет сети');
  });
});
