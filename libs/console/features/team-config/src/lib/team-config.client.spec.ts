import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { TeamConfigRevisionSummaryDto } from '@shared/contracts';
import { HISTORY_WINDOW, TeamConfigClient, teamConfigRevisionsUrlOf } from './team-config.client';

const URL = teamConfigRevisionsUrlOf('acme');

const summary = (revision: number): TeamConfigRevisionSummaryDto => ({
  revision,
  createdAt: '2026-11-14T16:20:00.000Z',
  createdBy: 'local-owner',
  createdByName: null,
  reason: null,
  paths: ['language'],
});

/** Revisions `from..to`, inclusive. */
const range = (from: number, to: number): TeamConfigRevisionSummaryDto[] =>
  Array.from({ length: to - from + 1 }, (_, at) => summary(from + at));

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
};

describe('TeamConfigClient.history', () => {
  let http: HttpTestingController;
  let client: TeamConfigClient;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(TeamConfigClient);
  });

  afterEach(() => http.verify());

  /** Answers the page that starts after `after` from a history of `total` revisions, as the Worker pages it. */
  async function answerPage(after: number, total: number): Promise<void> {
    await flush();
    const request = http.expectOne((req) => req.url === URL && req.params.get('after') === String(after));
    expect(request.request.params.get('limit')).toBe('100');
    const rows = range(after + 1, Math.min(total, after + 100));
    request.flush({ revisions: rows, nextCursor: after + 100 < total ? after + 100 : null });
  }

  it('keeps the newest revisions when the history is longer than the window: five full pages, then more', async () => {
    // The page showed revision 600; 101 more were saved meanwhile, so five full pages still leave a cursor.
    const reading = client.history('acme', 600);
    for (const after of [100, 200, 300, 400, 500, 600, 700]) {
      await answerPage(after, 701);
    }
    const result = await reading;
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.isCut).toBe(true);
    expect(result.revisions).toHaveLength(HISTORY_WINDOW);
    expect(result.revisions[0]?.revision).toBe(701);
    expect(result.revisions.at(-1)?.revision).toBe(202);
  });

  it('starts just below the shown revision: exactly the window, newest first, cut when older ones exist', async () => {
    const reading = client.history('acme', 650);
    for (const after of [150, 250, 350, 450, 550]) {
      await answerPage(after, 650);
    }
    const result = await reading;
    expect(result).toMatchObject({ ok: true, isCut: true });
    if (result.ok) {
      expect(result.revisions.map((revision) => revision.revision).slice(0, 2)).toEqual([650, 649]);
      expect(result.revisions).toHaveLength(HISTORY_WINDOW);
    }
  });

  it('reads a short history whole and does not call it cut', async () => {
    const reading = client.history('acme', 3);
    await answerPage(0, 3);
    expect(await reading).toEqual({ ok: true, revisions: range(1, 3).reverse(), isCut: false });
  });

  it('is a failure, not a partial list, when a page fails or a cursor does not move on', async () => {
    const failing = client.history('acme', 3);
    await flush();
    http.expectOne((req) => req.url === URL).flush('x', { status: 503, statusText: 'x' });
    expect(await failing).toEqual({ ok: false });

    const stuck = client.history('acme', 3);
    await flush();
    http.expectOne((req) => req.url === URL).flush({ revisions: range(1, 1), nextCursor: 0 });
    expect(await stuck).toEqual({ ok: false });
  });
});
