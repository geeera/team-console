import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
  PersistedStateStore,
} from '@console/shared/persisted-state';
import { Sheet } from '@console/shared/ui';
import type { ItemDto } from '@shared/contracts';
import { ItemEdit } from './item-edit';
import { statusChangeOf } from './item-field-picker';

const ITEM: ItemDto = {
  key: 'TC-7',
  number: 7,
  kind: 'bug',
  status: 'approved',
  severity: null,
  tier: null,
  sprint: 3,
  title: 'Old title',
  body: 'Old body',
  queue: null,
  labels: [],
  flags: [],
  state: 'open',
  closedAt: null,
  closedReason: null,
  createdBy: { kind: 'owner', name: 'owner' },
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  version: 2,
  source: 'console',
  sourceUrl: null,
};

const URL = '/api/v1/projects/team-console/items/7';

function setup(confirm = true) {
  const sheet = { confirm: vi.fn(async () => confirm) };
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideConsoleI18n(),
      { provide: PERSISTED_STATE_STORAGE, useValue: memoryPersistedStateStorage() },
      { provide: Sheet, useValue: sheet },
    ],
  });
  const fixture = TestBed.createComponent(ItemEdit);
  fixture.componentRef.setInput('slug', 'team-console');
  fixture.componentRef.setInput('item', ITEM);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const type = (selector: string, value: string): void => {
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (field === null) {
      throw new Error(`no ${selector}`);
    }
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  return {
    fixture,
    root,
    type,
    sheet,
    http: TestBed.inject(HttpTestingController),
    drafts: TestBed.inject(PersistedStateStore),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
}

describe('ItemEdit', () => {
  it('saves title and details with If-Match on the version the edit started from', async () => {
    const { fixture, type, http, drafts } = setup();
    const saved = vi.fn();
    fixture.componentInstance.saved.subscribe(saved);
    type('[data-testid="edit-title"]', 'New title');
    expect(drafts.taskDraftOf('team-console', 7)?.edit).toEqual({
      title: 'New title',
      body: 'Old body',
      baseVersion: 2,
    });
    const done = fixture.componentInstance.save();
    const request = http.expectOne(URL);
    expect(request.request.headers.get('If-Match')).toBe('"2"');
    expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.request.body).toEqual({ title: 'New title', body: 'Old body' });
    request.flush({ ...ITEM, title: 'New title', version: 3 });
    await done;
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }));
    expect(drafts.taskDraftOf('team-console', 7)).toBeUndefined();
  });

  it('keeps the owner’s text on a conflict, shows theirs on request and saves mine over their version', async () => {
    const { fixture, root, type, http } = setup();
    type('[data-testid="edit-body"]', 'My body');
    const done = fixture.componentInstance.save();
    http
      .expectOne(URL)
      .flush(
        { type: 'https://team-console/problems/item-version', title: 'x', status: 412 },
        { status: 412, statusText: 'Precondition Failed' },
      );
    await settle();
    http
      .expectOne((request) => request.method === 'GET' && request.url === URL)
      .flush({ ...ITEM, body: 'PM body', version: 5 });
    await done;
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="edit-conflict"]')).not.toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>('[data-testid="edit-body"]')?.value).toBe('My body');
    root.querySelector<HTMLButtonElement>('[data-testid="conflict-theirs"]')?.click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="edit-theirs"]')?.textContent).toContain('PM body');

    root.querySelector<HTMLButtonElement>('[data-testid="conflict-mine"]')?.click();
    const mine = http.expectOne((request) => request.method === 'PATCH');
    expect(mine.request.headers.get('If-Match')).toBe('"5"');
    expect(mine.request.body).toEqual({ title: 'Old title', body: 'My body' });
    mine.flush({ ...ITEM, body: 'My body', version: 6 });
  });

  it('retries a dropped save with the same idempotency key', async () => {
    const { fixture, root, type, http } = setup();
    type('[data-testid="edit-title"]', 'New title');
    const done = fixture.componentInstance.save();
    const first = http.expectOne(URL);
    const key = first.request.headers.get('Idempotency-Key');
    first.error(new ProgressEvent('error'), { status: 0 });
    await done;
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="tracker-failure"]')?.getAttribute('data-kind')).toBe('network');
    root.querySelector<HTMLButtonElement>('[data-testid="tracker-retry"]')?.click();
    const again = http.expectOne(URL);
    expect(again.request.headers.get('Idempotency-Key')).toBe(key);
    again.flush({ ...ITEM, title: 'New title', version: 3 });
  });

  it('asks before discarding changes and closes at once without any', async () => {
    const { fixture, type, sheet } = setup(true);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    await fixture.componentInstance.cancel();
    expect(sheet.confirm).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
    type('[data-testid="edit-title"]', 'Changed');
    await fixture.componentInstance.cancel();
    expect(sheet.confirm).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('refuses an empty title before sending anything', async () => {
    const { fixture, root, type, http } = setup();
    type('[data-testid="edit-title"]', '   ');
    await fixture.componentInstance.save();
    fixture.detectChanges();
    http.expectNone(URL);
    expect(root.querySelector('[data-testid="edit-title"]')?.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('statusChangeOf', () => {
  it('closes as not planned for "not needed" and reopens out of it', () => {
    expect(statusChangeOf(ITEM, 'closed')).toEqual({ state: 'closed', closedReason: 'not-planned' });
    expect(statusChangeOf({ ...ITEM, state: 'closed', closedReason: 'not-planned' }, 'approved')).toEqual({
      state: 'open',
      status: 'approved',
    });
    expect(statusChangeOf(ITEM, 'qa')).toEqual({ status: 'qa' });
    expect(statusChangeOf(ITEM, 'approved')).toBeNull();
  });
});
