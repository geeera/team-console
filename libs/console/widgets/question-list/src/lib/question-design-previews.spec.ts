import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ANSWERED_ITEMS_STORAGE, NEEDS_YOU_URL } from '@console/entities/project';
import { NEEDS_YOU_ITEMS_URL } from '@console/entities/question';
import { answerUrl } from '@console/features/answer-question';
import { DesignViewer } from '@console/features/design-viewer';
import { provideConsoleI18n } from '@console/shared/i18n';
import type {
  DesignManifestDto,
  DesignScreenDto,
  NeedsYouDto,
  NeedsYouItemDto,
  NeedsYouProjectRef,
} from '@shared/contracts';
import { QuestionList, STAMP_HOLD_MS } from './question-list';

const TC: NeedsYouProjectRef = { slug: 'team-console', name: 'Team Console' };
const SHA = 'c'.repeat(40);
const DESIGN = 90004;
const MANIFEST_URL = `/api/v1/projects/team-console/designs/${DESIGN}`;
const FOLDER = `docs/design/${DESIGN}-demo-screen`;

function screen(file: string, extra: Partial<DesignScreenDto> = {}): DesignScreenDto {
  return {
    path: `${FOLDER}/${file}`,
    file,
    caption: file.replace(/^(?:phone|mac)-\d+-/, '').replace(/\.\w+$/, ''),
    device: file.startsWith('phone-') ? 'phone' : file.startsWith('mac-') ? 'mac' : null,
    type: 'png',
    size: 1000,
    tooLarge: false,
    url: `https://github.com/geeera/team-console/blob/${SHA}/${FOLDER}/${file}`,
    ...extra,
  };
}

const MANIFEST: DesignManifestDto = {
  issue: DESIGN,
  sha: SHA,
  ref: 'pull-request',
  screens: [
    screen('mac-01-list.png'),
    screen('mac-02-detail.png'),
    screen('phone-01-list.png'),
    screen('phone-02-detail.png'),
    screen('phone-03-answer.png'),
    screen('phone-04-loading.png'),
  ],
  interactive: null,
  partial: false,
};

function item(number: number, overrides: Partial<NeedsYouItemDto> = {}): NeedsYouItemDto {
  return {
    section: 'design',
    number,
    title: `Design ${number}`,
    url: `https://github.com/geeera/team-console/issues/${number}`,
    ask: null,
    authorTrusted: true,
    category: null,
    recommendation: 'approve',
    context: null,
    project: TC,
    allowedCommands: ['approve', 'reject'],
    ...overrides,
  };
}

function needsYouBody(items: NeedsYouItemDto[]): NeedsYouDto {
  return {
    items,
    projects: [{ ...TC, setup: false, setupUrl: null, paused: false, pausedUrl: null, problem: null }],
    omittedProjects: [],
  };
}

@Component({ imports: [QuestionList], template: `<tc-question-list />` })
class Host {}

const overlay = (): HTMLElement | null => document.querySelector('.cdk-overlay-container');
const viewerDialog = (): HTMLElement | null => overlay()?.querySelector('tc-sheet-container') ?? null;
const textOf = (element: Element | null | undefined): string =>
  element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('QuestionList design previews (#290)', () => {
  it('after «Повторить», focus moves to the first preview, or back to «Повторить» when it fails again (#300)', async () => {
    const { fixture, card } = await render([item(DESIGN)]);
    const fail = (): void =>
      http.expectOne(MANIFEST_URL).flush({}, { status: 503, statusText: 'Service Unavailable' });
    const retryButton = (): HTMLButtonElement =>
      card(DESIGN).querySelector('[data-testid="question-previews-failed"] button') as HTMLButtonElement;
    fail();
    await settle();
    await fixture.whenStable();

    retryButton().focus();
    retryButton().click();
    await settle();
    fail();
    await settle();
    await fixture.whenStable();
    expect(document.activeElement).toBe(retryButton());

    retryButton().click();
    await settle();
    http.expectOne(MANIFEST_URL).flush(MANIFEST);
    await settle();
    await fixture.whenStable();
    expect(document.activeElement).toBe(card(DESIGN).querySelector('[data-testid="question-preview"]'));
  });

  let http: HttpTestingController;

  async function settle(): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async function render(items: NeedsYouItemDto[]) {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: ANSWERED_ITEMS_STORAGE, useValue: { read: () => null, write: () => undefined } },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
    http.expectOne(NEEDS_YOU_ITEMS_URL).flush(needsYouBody(items));
    await settle();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const card = (number: number): HTMLElement =>
      root.querySelector(`li[data-number="${number}"]`) as HTMLElement;
    return { fixture, root, card };
  }

  afterEach(() => {
    http.verify();
    overlay()?.remove();
  });

  it('shows three skeletons, then three screens phone first with «+N» on the last, «Все экраны» and the summary', async () => {
    const { fixture, card } = await render([item(DESIGN)]);
    const design = card(DESIGN);
    expect(
      design.querySelectorAll('[data-testid="question-previews-loading"] tc-design-preview'),
    ).toHaveLength(3);

    http.expectOne(MANIFEST_URL).flush(MANIFEST);
    await settle();
    await fixture.whenStable();

    const list = design.querySelector('[data-testid="question-previews"]') as HTMLElement;
    expect(list.tagName).toBe('UL');
    expect(list.getAttribute('aria-label')).toBe('Экраны дизайна, 6');
    const thumbs = [...list.querySelectorAll<HTMLButtonElement>('[data-testid="question-preview"]')];
    expect(thumbs.map((thumb) => thumb.dataset['path'])).toEqual([
      `${FOLDER}/phone-01-list.png`,
      `${FOLDER}/phone-02-detail.png`,
      `${FOLDER}/phone-03-answer.png`,
    ]);
    expect(thumbs.map((thumb) => thumb.getAttribute('aria-label'))).toEqual([
      'Экран 1 из 6: list. Открыть',
      'Экран 2 из 6: detail. Открыть',
      'Экран 3 из 6: answer. Открыть',
    ]);
    // Each image is decorative and its own screen from the file route; the button carries the name.
    const images = thumbs.map((thumb) => thumb.querySelector('img') as HTMLImageElement);
    expect(images.map((img) => img.getAttribute('alt'))).toEqual(['', '', '']);
    expect(images[1]?.getAttribute('src')).toBe(
      `${MANIFEST_URL}/${SHA}/file?path=${encodeURIComponent(`${FOLDER}/phone-02-detail.png`)}`,
    );
    expect(thumbs[2]?.querySelector('[data-testid="question-previews-more"]')?.textContent?.trim()).toBe(
      '+3',
    );
    expect(thumbs[0]?.querySelector('[data-testid="question-previews-more"]')).toBeNull();
    expect(textOf(design.querySelector('[data-testid="question-previews-all"]'))).toBe('Все экраны (6)');
    expect(textOf(design.querySelector('[data-testid="design-summary"]'))).toBe(
      `#${DESIGN} · 6 экранов · iPhone и Mac`,
    );
  });

  it('opens the viewer on the tapped screen with the card’s answers, and «Все экраны» on the grid', async () => {
    const { fixture, card } = await render([
      item(DESIGN, { context: summaryContext('Экран дизайна и демо') }),
    ]);
    http.expectOne(MANIFEST_URL).flush(MANIFEST);
    await settle();
    await fixture.whenStable();
    const viewer = TestBed.inject(DesignViewer);
    const open = vi.spyOn(viewer, 'open');

    card(DESIGN).querySelectorAll<HTMLButtonElement>('[data-testid="question-preview"]')[1]?.click();
    await settle();
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'team-console',
        issue: DESIGN,
        title: 'Экран дизайна и демо',
        screen: `${FOLDER}/phone-02-detail.png`,
        actions: expect.anything(),
      }),
    );
    // Opening reads the list again; the viewer shows the screen it was opened on, on its device.
    http.expectOne(MANIFEST_URL).flush(MANIFEST);
    await settle();
    await fixture.whenStable();
    expect(textOf(viewerDialog()?.querySelector('[data-testid="viewer-position"]'))).toBe('2 из 4 · detail');
    expect(viewerDialog()?.querySelectorAll('[data-testid="viewer-actions"] [data-command]')).toHaveLength(2);

    (card(DESIGN).querySelector('[data-testid="question-previews-all"]') as HTMLButtonElement).click();
    await settle();
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'grid' }));
    expect(open.mock.lastCall?.[0]).not.toHaveProperty('screen');
    http.match(MANIFEST_URL).forEach((request) => request.flush(MANIFEST));
    await settle();
    // One viewer at a time: the first one closed when the second opened.
    expect(overlay()?.querySelectorAll('tc-sheet-container')).toHaveLength(1);
  });

  it('approving inside the viewer closes it, stamps the card and moves focus to its receipt', async () => {
    const { fixture, root, card } = await render([item(DESIGN), item(DESIGN + 1, { section: 'question' })]);
    http.expectOne(MANIFEST_URL).flush(MANIFEST);
    await settle();
    await fixture.whenStable();

    card(DESIGN).querySelector<HTMLButtonElement>('[data-testid="question-preview"]')?.click();
    await settle();
    http.expectOne(MANIFEST_URL).flush(MANIFEST);
    await settle();
    await fixture.whenStable();

    (
      viewerDialog()?.querySelector(
        '[data-testid="viewer-actions"] [data-command="approve"]',
      ) as HTMLButtonElement
    ).click();
    await settle();
    http.expectOne(answerUrl(TC.slug, DESIGN)).flush(
      {
        commentId: 11,
        url: `https://github.com/geeera/team-console/issues/${DESIGN}#issuecomment-11`,
        section: 'design',
        command: 'approve',
        replayed: false,
      },
      { status: 201, statusText: 'Created' },
    );
    await settle();
    await fixture.whenStable();
    http.match(NEEDS_YOU_URL).forEach((request) => request.flush({ items: [] }));

    expect(viewerDialog()).toBeNull();
    expect(card(DESIGN).querySelector('tc-card')?.classList).toContain('tc-card--stamped');
    expect(textOf(root.querySelector('[data-testid="announcement"]'))).toContain(
      `Ответ на #${DESIGN} записан`,
    );

    await new Promise((resolve) => setTimeout(resolve, STAMP_HOLD_MS + 50));
    await fixture.whenStable();
    await settle();
    expect(document.activeElement).toBe(card(DESIGN).querySelector('tc-receipt'));
  });

  it('builds no previews for an outsider’s design or for other sections, so nothing is read or shown', async () => {
    const { card } = await render([
      item(DESIGN, { authorTrusted: false }),
      item(DESIGN + 1, { section: 'question' }),
      item(DESIGN + 2, { section: 'release', allowedCommands: ['go', 'no-go'] }),
    ]);
    expect(card(DESIGN).querySelector('tc-question-design-previews')).toBeNull();
    expect(card(DESIGN).querySelector('img')).toBeNull();
    expect(textOf(card(DESIGN).querySelector('[data-testid="previews-untrusted"]'))).toContain(
      'Превью скрыто',
    );
    expect(card(DESIGN + 1).querySelector('tc-question-design-previews')).toBeNull();
    expect(card(DESIGN + 2).querySelector('tc-question-design-previews')).toBeNull();
    // http.verify() in afterEach: no manifest was asked for.
  });

  it('says so when the team attached no screens, and offers Retry when the list failed', async () => {
    const { fixture, card } = await render([item(DESIGN), item(DESIGN + 1)]);
    http.expectOne(MANIFEST_URL).flush({ ...MANIFEST, screens: [] });
    http
      .expectOne(`/api/v1/projects/team-console/designs/${DESIGN + 1}`)
      .flush({}, { status: 502, statusText: 'Bad Gateway' });
    await settle();
    await fixture.whenStable();

    expect(textOf(card(DESIGN).querySelector('[data-testid="question-previews-none"]'))).toContain(
      'Команда не приложила экраны к этому дизайну',
    );
    expect(card(DESIGN).querySelector('[data-testid="question-previews-all"]')).toBeNull();
    // The answer buttons stay usable in either state.
    expect(card(DESIGN).querySelector('[data-command="approve"]')).not.toBeNull();

    const failed = card(DESIGN + 1).querySelector('[data-testid="question-previews-failed"]') as HTMLElement;
    expect(textOf(failed)).toContain('Не удалось загрузить экраны.');
    expect(card(DESIGN + 1).querySelector('[data-command="approve"]')).not.toBeNull();
    (failed.querySelector('button') as HTMLButtonElement).click();
    await settle();
    http
      .expectOne(`/api/v1/projects/team-console/designs/${DESIGN + 1}`)
      .flush({ ...MANIFEST, issue: DESIGN + 1 });
    await settle();
    await fixture.whenStable();
    expect(card(DESIGN + 1).querySelectorAll('[data-testid="question-preview"]')).toHaveLength(3);
  });
});

function summaryContext(summary: string): NeedsYouItemDto['context'] {
  return {
    structured: true,
    summary,
    question: null,
    why: null,
    ifApproved: null,
    ifRejected: null,
    costAndRisk: null,
  };
}
