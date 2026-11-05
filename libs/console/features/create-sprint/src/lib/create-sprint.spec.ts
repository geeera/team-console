import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { ConfirmFailure, Sheet, type ConfirmOptions } from '@console/shared/ui';
import { CreateSprint } from './create-sprint';

const URL = '/api/v1/projects/team-console/sprints';
const SPRINT_2 = {
  number: 2,
  title: 'Sprint 02',
  dueOn: '2026-11-27',
  state: 'open',
  description: '',
  createdAt: 'x',
  closedAt: null,
};

function setup() {
  let options: ConfirmOptions | null = null;
  const sheet = {
    confirm: vi.fn(async (given: ConfirmOptions) => {
      options = given;
      return true;
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideConsoleI18n(),
      { provide: Sheet, useValue: sheet },
    ],
  });
  const service = TestBed.inject(CreateSprint);
  service.now = () => new Date(2026, 10, 5, 12);
  return {
    service,
    http: TestBed.inject(HttpTestingController),
    options: () => options as ConfirmOptions | null,
  };
}

describe('CreateSprint', () => {
  it('names the next sprint, prefills 14 days after the latest demo and refuses a date not after it', async () => {
    const { service, http, options } = setup();
    const opened = service.open({ slug: 'team-console' });
    http.expectOne(URL).flush({ sprints: [SPRINT_2] });
    await opened;
    const confirm = options();
    expect(confirm?.title).toBe('Новый спринт: Sprint 03');
    expect(confirm?.input?.value).toBe('2026-12-11');
    const check = confirm?.input?.check;
    expect(check?.('2026-11-20').error).toContain('Демо Sprint 03 должно быть позже демо Sprint 02');
    expect(check?.('2026-11-01').error).toBe('Эта дата уже прошла. Выберите сегодня или позже.');
    expect(check?.('').error).toBe('Выберите дату демо.');
    expect(check?.('2026-12-11').hint).toContain('Спринт начнётся после демо Sprint 02');
  });

  it('creates it with one idempotency key, which a retry in the dialog reuses', async () => {
    const { service, http, options } = setup();
    const opened = service.open({ slug: 'team-console' });
    http.expectOne(URL).flush({ sprints: [SPRINT_2] });
    await opened;
    const action = options()?.action as (value: string) => Promise<unknown>;
    const first = action('2026-12-11');
    const dropped = http.expectOne((r) => r.method === 'POST');
    const key = dropped.request.headers.get('Idempotency-Key');
    expect(dropped.request.body).toEqual({ dueOn: '2026-12-11' });
    dropped.error(new ProgressEvent('error'), { status: 0 });
    await expect(first).rejects.toBeInstanceOf(ConfirmFailure);
    const second = action('2026-12-11');
    const again = http.expectOne((r) => r.method === 'POST');
    expect(again.request.headers.get('Idempotency-Key')).toBe(key);
    again.flush(
      { ...SPRINT_2, number: 3, title: 'Sprint 03', dueOn: '2026-12-11' },
      { status: 201, statusText: 'Created' },
    );
    await second;
  });
});
