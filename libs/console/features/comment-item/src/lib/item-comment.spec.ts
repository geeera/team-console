import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
  PersistedStateStore,
} from '@console/shared/persisted-state';
import { ItemComment } from './item-comment';

const URL = '/api/v1/projects/team-console/items/7/comments';
const COMMENT = {
  id: 1,
  kind: 'comment',
  author: { kind: 'owner', name: 'owner' },
  body: '/approve',
  createdAt: '2026-11-05T10:00:00Z',
  source: 'console',
  sourceUrl: null,
};

function setup(isDecisionWaiting = false) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideConsoleI18n(),
      { provide: PERSISTED_STATE_STORAGE, useValue: memoryPersistedStateStorage() },
    ],
  });
  const fixture = TestBed.createComponent(ItemComment);
  fixture.componentRef.setInput('slug', 'team-console');
  fixture.componentRef.setInput('number', 7);
  fixture.componentRef.setInput('isDecisionWaiting', isDecisionWaiting);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const field = root.querySelector<HTMLTextAreaElement>(
    '[data-testid="comment-field"]',
  ) as HTMLTextAreaElement;
  const type = (value: string): void => {
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  return {
    fixture,
    root,
    field,
    type,
    http: TestBed.inject(HttpTestingController),
    drafts: TestBed.inject(PersistedStateStore),
  };
}

describe('ItemComment', () => {
  it('says a /command line is not a decision, and sends it as a plain comment', async () => {
    const { fixture, root, type, http, drafts } = setup(true);
    type('/approve');
    expect(root.querySelector('[data-testid="comment-command-note"]')?.textContent).toContain('«Утвердить»');
    expect(drafts.taskDraftOf('team-console', 7)?.comment).toBe('/approve');
    const sent = fixture.componentInstance.send();
    const request = http.expectOne(URL);
    expect(request.request.body).toEqual({ body: '/approve' });
    expect(request.request.headers.get('Idempotency-Key')).toBeTruthy();
    request.flush(COMMENT, { status: 201, statusText: 'Created' });
    await sent;
    fixture.detectChanges();
    expect(drafts.taskDraftOf('team-console', 7)).toBeUndefined();
    expect(root.querySelector<HTMLTextAreaElement>('[data-testid="comment-field"]')?.value).toBe('');
  });

  it('hands a dropped send up with a retry that reuses the key', async () => {
    const { fixture, type, http } = setup();
    const failed = vi.fn();
    fixture.componentInstance.failed.subscribe(failed);
    type('Looks good');
    const sent = fixture.componentInstance.send();
    const first = http.expectOne(URL);
    const key = first.request.headers.get('Idempotency-Key');
    first.error(new ProgressEvent('error'), { status: 0 });
    await sent;
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ failure: expect.objectContaining({ kind: 'network' }) }),
    );
    const retry = failed.mock.calls[0]?.[0].retry as () => Promise<void>;
    const again = retry();
    const second = http.expectOne(URL);
    expect(second.request.headers.get('Idempotency-Key')).toBe(key);
    second.flush({ ...COMMENT, body: 'Looks good' }, { status: 201, statusText: 'Created' });
    await again;
  });

  it('sends nothing when the box is empty or the screen is offline', async () => {
    const { fixture, type, http } = setup();
    await fixture.componentInstance.send();
    fixture.componentRef.setInput('off', 'Нет сети');
    type('Hello');
    await fixture.componentInstance.send();
    http.expectNone(URL);
  });
});
