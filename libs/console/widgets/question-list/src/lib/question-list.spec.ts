import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ANSWERED_ITEMS_STORAGE, AnsweredItems, NEEDS_YOU_URL } from '@console/entities/project';
import { NEEDS_YOU_ITEMS_URL, projectQuestionsUrl } from '@console/entities/question';
import { answerUrl } from '@console/features/answer-question';
import { provideConsoleI18n } from '@console/shared/i18n';
import { ANSWERS } from '@shared/owner-grammar';
import type {
  NeedsYouDto,
  NeedsYouItemDto,
  NeedsYouProjectRef,
  QuestionsDto,
  Section,
} from '@shared/contracts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QuestionList, STAMP_HOLD_MS } from './question-list';

// The plugin's own inbox (`brief.needs`) for real repositories, written by libs/worker/read-models/fixtures/golden.py.
const GOLDEN_DIR = resolve(import.meta.dirname, '../../../../../worker/read-models/fixtures');

interface GoldenItem {
  readonly section: Section;
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly ask: string | null;
}

function goldenInbox(name: string): GoldenItem[] {
  const expected = JSON.parse(readFileSync(resolve(GOLDEN_DIR, `${name}.expected.json`), 'utf8')) as {
    inbox: { items: GoldenItem[] };
  };
  return expected.inbox.items;
}

const TC: NeedsYouProjectRef = { slug: 'team-console', name: 'Team Console' };

function needsYouItem(
  project: NeedsYouProjectRef,
  number: number,
  overrides: Partial<NeedsYouItemDto> = {},
): NeedsYouItemDto {
  return {
    section: 'question',
    number,
    title: `Item ${number}`,
    url: `https://github.com/geeera/${project.slug}/issues/${number}`,
    ask: null,
    authorTrusted: true,
    category: null,
    recommendation: null,
    context: null,
    project,
    allowedCommands: ['approve', 'reject'],
    ...overrides,
  };
}

function needsYouBody(items: NeedsYouItemDto[], extra: Partial<NeedsYouDto> = {}): NeedsYouDto {
  const slugs = [...new Map(items.map((item) => [item.project.slug, item.project])).values()];
  return {
    items,
    projects: slugs.map((project) => ({
      ...project,
      setup: false,
      setupUrl: null,
      paused: false,
      pausedUrl: null,
      problem: null,
    })),
    omittedProjects: [],
    ...extra,
  };
}

@Component({
  imports: [QuestionList],
  template: `<tc-question-list [project]="project()" />`,
})
class Host {
  readonly project = signal<NeedsYouProjectRef | null>(null);
}

describe('QuestionList', () => {
  let http: HttpTestingController;

  async function tick(): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async function render(project: NeedsYouProjectRef | null) {
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
    fixture.componentInstance.project.set(project);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const settle = async (): Promise<void> => {
      await tick();
      await fixture.whenStable();
    };
    const numbers = () =>
      [...root.querySelectorAll('li[data-number]')].map((row) => Number(row.getAttribute('data-number')));
    return { fixture, root, settle, numbers };
  }

  afterEach(() => http.verify());

  it.each(['team-console', 'storify', 'edge-cases'])(
    'a project lists the same items, in the same order, as the plugin inbox of %s',
    async (name) => {
      const golden = goldenInbox(name);
      const { settle, numbers, root } = await render(TC);
      const body: QuestionsDto = {
        items: golden.map((item) => ({
          ...item,
          authorTrusted: true,
          context: null,
          body: '',
          allowedCommands: ANSWERS[item.section],
        })),
      };
      http.expectOne(projectQuestionsUrl(TC.slug)).flush(body);
      await settle();

      expect(numbers()).toEqual(golden.map((item) => item.number));
      expect([...root.querySelectorAll('tc-question-card h2')].map((title) => title.textContent)).toEqual(
        golden.map((item) => item.title),
      );
      expect(root.querySelector('[data-testid="project-tag"]')).toBeNull();
    },
  );

  it('Needs you keeps the server order (inbox order, then project), tags each card and counts what waits', async () => {
    const storify = { slug: 'storify', name: 'Storify' };
    const { settle, numbers, root } = await render(null);
    http
      .expectOne(NEEDS_YOU_ITEMS_URL)
      .flush(
        needsYouBody([
          needsYouItem(TC, 10, { section: 'release', allowedCommands: ['go', 'no-go', 'override'] }),
          needsYouItem(TC, 72),
          needsYouItem(storify, 5),
          needsYouItem(TC, 21, { section: 'owner', allowedCommands: ['done'] }),
        ]),
      );
    await settle();

    expect(numbers()).toEqual([10, 72, 5, 21]);
    expect(
      [...root.querySelectorAll('[data-testid="project-tag"]')].map((tag) => tag.textContent?.trim()),
    ).toEqual(['Team Console', 'Team Console', 'Storify', 'Team Console']);
    expect(root.querySelector('[data-testid="lead"]')?.textContent).toContain('Ждут ответа: 4 · проектов: 2');
  });

  it('answering from Needs you stamps the card, then folds it into a receipt linking the comment', async () => {
    const { settle, root, fixture } = await render(null);
    http.expectOne(NEEDS_YOU_ITEMS_URL).flush(needsYouBody([needsYouItem(TC, 72), needsYouItem(TC, 73)]));
    await settle();

    const approve = root.querySelector('li[data-number="72"] [data-command="approve"]') as HTMLButtonElement;
    approve.focus();
    approve.click();
    await settle();
    http.expectOne(answerUrl(TC.slug, 72)).flush(
      {
        commentId: 9,
        url: 'https://github.com/geeera/team-console/issues/72#issuecomment-9',
        section: 'question',
        command: 'approve',
        replayed: false,
      },
      { status: 201, statusText: 'Created' },
    );
    await settle();
    http.match(NEEDS_YOU_URL).forEach((request) => request.flush({ items: [] }));

    expect(root.querySelector('li[data-number="72"] tc-card')?.classList).toContain('tc-card--stamped');
    expect(root.querySelector('li[data-number="72"] tc-answer-question')).toBeNull();
    expect(root.querySelector('[data-testid="announcement"]')?.textContent).toContain(
      'Ответ на #72 записан: Утвердить',
    );

    await new Promise((resolve) => setTimeout(resolve, STAMP_HOLD_MS + 50));
    await fixture.whenStable();
    await settle();

    const receipt = root.querySelector('li[data-number="72"] tc-receipt') as HTMLElement;
    expect(root.querySelector('li[data-number="72"] tc-question-card')).toBeNull();
    expect(receipt.textContent).toContain('Вы: Утвердить');
    expect(receipt.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/geeera/team-console/issues/72#issuecomment-9',
    );
    expect(document.activeElement).toBe(receipt);
    expect(root.querySelector('[data-testid="lead"]')?.textContent).toContain('Ждут ответа: 1');
    expect(root.querySelector('li[data-number="73"] tc-question-card')).not.toBeNull();
  });

  it('an answered item still listed after a reload shows its receipt; one GitHub dropped is forgotten', async () => {
    const { settle, root, fixture } = await render(TC);
    TestBed.inject(AnsweredItems).record({
      slug: TC.slug,
      number: 72,
      command: 'reject',
      url: 'https://github.com/geeera/team-console/issues/72#issuecomment-1',
      answeredAt: new Date().toISOString(),
    });
    TestBed.inject(AnsweredItems).record({
      slug: TC.slug,
      number: 80,
      command: 'approve',
      url: 'https://github.com/geeera/team-console/issues/80#issuecomment-2',
      answeredAt: new Date().toISOString(),
    });
    const item = { ...needsYouItem(TC, 72), body: '' };
    http.expectOne(projectQuestionsUrl(TC.slug)).flush({ items: [item] });
    await settle();
    await fixture.whenStable();

    expect(root.querySelector('li[data-number="72"] tc-receipt')?.classList).toContain(
      'tc-receipt--negative',
    );
    expect(TestBed.inject(AnsweredItems).has(TC.slug, 80)).toBe(false);
  });

  it('shows the shared error block when the list cannot be read, and Retry reads it again', async () => {
    const { settle, root } = await render(null);
    http.expectOne(NEEDS_YOU_ITEMS_URL).flush({ title: 'down' }, { status: 503, statusText: 'Unavailable' });
    await settle();

    const block = root.querySelector('[data-testid="load-error"]') as HTMLElement;
    expect(block.getAttribute('role')).toBe('alert');
    expect(block.textContent).toContain('Не удалось загрузить вопросы');
    (block.querySelector('button') as HTMLButtonElement).click();
    await settle();
    http.expectOne(NEEDS_YOU_ITEMS_URL).flush(needsYouBody([]));
    await settle();

    expect(root.querySelector('[data-testid="empty"]')?.textContent).toContain(
      'От вас сейчас ничего не нужно',
    );
  });

  it('a response of the wrong shape is an error, not a half-rendered list', async () => {
    const { settle, root } = await render(null);
    http.expectOne(NEEDS_YOU_ITEMS_URL).flush({ items: [{ project: 'tc' }] });
    await settle();

    expect(root.querySelector('[data-testid="load-error"]')).not.toBeNull();
    expect(root.querySelector('tc-question-card')).toBeNull();
  });

  it('names the projects it could not read, and those beyond the cap, while listing the rest', async () => {
    const { settle, root } = await render(null);
    const body = needsYouBody([needsYouItem(TC, 72)]);
    http.expectOne(NEEDS_YOU_ITEMS_URL).flush({
      ...body,
      projects: [
        ...body.projects,
        {
          slug: 'broken',
          name: 'Broken',
          setup: false,
          setupUrl: null,
          paused: false,
          pausedUrl: null,
          problem: { type: 'github-app-not-installed', title: 'x', status: 409 },
        },
      ],
      omittedProjects: [{ slug: 'seventh', name: 'Seventh' }],
    });
    await settle();

    expect(root.querySelector('[data-testid="project-problem"]')?.textContent).toContain(
      'Broken: вопросы не прочитаны — приложение консоли не установлено в репозитории',
    );
    expect(root.querySelector('[data-testid="omitted"]')?.textContent).toContain('Seventh');
    expect(root.querySelectorAll('tc-question-card')).toHaveLength(1);
  });

  describe('projects that need the owner outside a card (#205)', () => {
    const CHECKLIST = 'https://github.com/geeera/private-product/blob/HEAD/.product-team/owner-checklist.md';
    const PRIVATE = {
      slug: 'private-product',
      name: 'private-product',
      setup: true,
      setupUrl: CHECKLIST,
      paused: false,
      pausedUrl: null,
      problem: null,
    };
    const BROKEN = {
      slug: 'broken',
      name: 'Broken',
      setup: false,
      setupUrl: null,
      paused: false,
      pausedUrl: null,
      problem: { type: 'github-app-not-installed', title: 'x', status: 409 },
    };

    it('a project that needs setup is a Banner row above the cards linking to its GitHub checklist', async () => {
      const { settle, root } = await render(null);
      const body = needsYouBody([needsYouItem(TC, 72)]);
      http.expectOne(NEEDS_YOU_ITEMS_URL).flush({ ...body, projects: [...body.projects, PRIVATE] });
      await settle();

      const rows = root.querySelectorAll<HTMLAnchorElement>('[data-testid="project-setup"]');
      expect(rows).toHaveLength(1);
      const row = rows[0] as HTMLAnchorElement;
      expect(row.classList).toContain('tc-banner');
      expect(row.classList).toContain('tc-banner--warning');
      expect(row.dataset['project']).toBe('private-product');
      expect(row.href).toBe(CHECKLIST);
      expect(row.target).toBe('_blank');
      expect(row.rel).toBe('noopener noreferrer');
      expect(row.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'private-product: нужна настройка (откроется на GitHub)',
      );
      expect(root.querySelector('[data-testid="project-attention"]')?.getAttribute('aria-label')).toBe(
        'Проекты, которые ждут вас',
      );
      // Above the cards, and counted in the summary line.
      const list = root.querySelector('.questions__list') as HTMLElement;
      expect(row.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(root.querySelector('[data-testid="lead"]')?.textContent).toContain(
        'Ждут ответа: 1 · проектов: 2',
      );
    });

    it('a setup link that is not a github.com page opens the project’s settings instead', async () => {
      const { settle, root } = await render(null);
      http.expectOne(NEEDS_YOU_ITEMS_URL).flush({
        ...needsYouBody([]),
        projects: [{ ...PRIVATE, setupUrl: 'https://evil.example/checklist' }],
      });
      await settle();

      const row = root.querySelector('[data-testid="project-setup"]') as HTMLAnchorElement;
      expect(row.getAttribute('href')).toBe('/settings/projects/private-product');
      expect(row.target).toBe('');
    });

    it('a project whose inbox could not be read is a row linking to its settings', async () => {
      const { settle, root } = await render(null);
      http.expectOne(NEEDS_YOU_ITEMS_URL).flush({ ...needsYouBody([]), projects: [BROKEN] });
      await settle();

      const row = root.querySelector('[data-testid="project-problem"]') as HTMLAnchorElement;
      expect(row.tagName).toBe('A');
      expect(row.classList).toContain('tc-banner');
      expect(row.getAttribute('href')).toBe('/settings/projects/broken');
    });

    it('with no questions, the rows replace "nothing needs you" and the summary still counts them', async () => {
      const { settle, root } = await render(null);
      http.expectOne(NEEDS_YOU_ITEMS_URL).flush({ ...needsYouBody([]), projects: [PRIVATE, BROKEN] });
      await settle();

      expect(root.querySelectorAll('.questions__attention > li')).toHaveLength(2);
      expect(root.querySelector('[data-testid="empty"]')).toBeNull();
      expect(root.querySelector('.questions__list')).toBeNull();
      expect(root.querySelector('[data-testid="lead"]')?.textContent).toContain('Вопросов нет · проектов: 2');
    });

    it('when no project needs setup, nothing extra is shown', async () => {
      const { settle, root } = await render(null);
      http.expectOne(NEEDS_YOU_ITEMS_URL).flush(needsYouBody([]));
      await settle();

      expect(root.querySelector('[data-testid="project-attention"]')).toBeNull();
      expect(root.querySelector('[data-testid="lead"]')).toBeNull();
      expect(root.querySelector('[data-testid="empty"]')).not.toBeNull();
    });

    it('one project’s Questions never shows the cross-project rows', async () => {
      const { settle, root } = await render(TC);
      http.expectOne(projectQuestionsUrl(TC.slug)).flush({ items: [] });
      await settle();

      expect(root.querySelector('[data-testid="project-attention"]')).toBeNull();
    });
  });
});
