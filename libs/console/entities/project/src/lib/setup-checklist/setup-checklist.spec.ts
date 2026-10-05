import { ApplicationInitStatus } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { ProjectSetupDto } from '@shared/contracts';
import { setupStepsOf } from '../project-setup';
import { SetupChecklist, SetupChecklistContext } from './setup-checklist';

const CONTEXT: SetupChecklistContext = {
  repo: 'geeera/fieldnote',
  slug: 'field-note',
  appName: 'team-console-dev',
  installUrl: 'https://github.com/apps/team-console-dev/installations/new',
  login: 'geeera',
  repoOwner: 'geeera',
  lastEventAt: null,
  environment: 'dev',
};

const SETUP: ProjectSetupDto = {
  appInstalled: 'missing',
  repoOwner: 'not-checked',
  projectYml: 'missing',
  events: 'never',
  lastEventAt: null,
  routineToken: 'missing',
  connection: { state: 'connected', login: 'geeera' },
  accessLostAt: null,
  ownerLanguage: 'ru',
  installUrl: 'https://github.com/apps/team-console-dev/installations/new',
};

describe('SetupChecklist', () => {
  let fixture: ComponentFixture<SetupChecklist>;
  let root: HTMLElement;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    TestBed.configureTestingModule({ imports: [SetupChecklist], providers: [provideConsoleI18n()] });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    fixture = TestBed.createComponent(SetupChecklist);
    fixture.componentRef.setInput('steps', setupStepsOf(SETUP));
    fixture.componentRef.setInput('context', CONTEXT);
    await fixture.whenStable();
    root = fixture.nativeElement as HTMLElement;
  });

  const step = (id: string): HTMLElement => root.querySelector(`[data-step="${id}"]`) as HTMLElement;
  const stateOf = (id: string): string =>
    step(id).querySelector('[data-testid="step-state"]')?.textContent?.trim() ?? '';

  it('says every step’s state in words, in order, as a labelled list', () => {
    const list = root.querySelector('ol') as HTMLElement;
    expect(list.getAttribute('aria-label')).toBe('Шаги настройки');
    expect(Array.from(list.querySelectorAll('li')).map((item) => item.dataset['step'])).toEqual([
      'app',
      'owner',
      'yml',
      'events',
      'routine',
    ]);
    expect(stateOf('app')).toBe('Не хватает');
    expect(stateOf('owner')).toBe('Не проверено');
    expect(stateOf('events')).toBe('Ждём');
    expect(stateOf('routine')).toBe('Не хватает');
    expect(step('app').querySelector('h3')?.textContent).toContain('team-console-dev');
    expect(step('events').textContent).toContain('Делать ничего не нужно');
    for (const mark of Array.from(root.querySelectorAll('.step__mark'))) {
      expect(mark.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('a waiting step shows a clock instead of its number and offers no "How to fix" (#205)', () => {
    const mark = step('events').querySelector('.step__mark') as HTMLElement;
    expect(mark.dataset['mark']).toBe('clock');
    expect(mark.querySelector('tc-icon')).not.toBeNull();
    expect(mark.textContent?.trim()).toBe('');
    expect(step('events').querySelector('.step__how-toggle')).toBeNull();
    expect(step('events').querySelector('.step__how')).toBeNull();
    expect(step('routine').querySelector('.step__how-toggle')).not.toBeNull();
  });

  it('opens "How to fix" as a disclosure with the server’s install link marked external', async () => {
    const toggle = step('app').querySelector('.step__how-toggle') as HTMLButtonElement;
    const panel = root.querySelector(`#${toggle.getAttribute('aria-controls')}`) as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hidden).toBe(true);

    toggle.click();
    await fixture.whenStable();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    const link = panel.querySelector('a') as HTMLAnchorElement;
    expect(link.href).toBe(CONTEXT.installUrl);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.textContent).toContain('(откроется на GitHub)');
  });

  it('copies the routine secret command for this slug and environment, never a value', async () => {
    (step('routine').querySelector('.step__how-toggle') as HTMLButtonElement).click();
    await fixture.whenStable();
    const code = step('routine').querySelector('code')?.textContent;
    expect(code).toBe('npx wrangler secret put ROUTINE_TOKEN_FIELD_NOTE --env dev');

    (step('routine').querySelector('.step__code button') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(writeText).toHaveBeenCalledWith('npx wrangler secret put ROUTINE_TOKEN_FIELD_NOTE --env dev');
    expect(step('routine').querySelector('.step__code button')?.textContent).toContain('Скопировано');
  });

  it('names the mismatching owner and the connected account from the server', async () => {
    fixture.componentRef.setInput(
      'steps',
      setupStepsOf({ ...SETUP, appInstalled: 'ok', repoOwner: 'mismatch', projectYml: 'ok' }),
    );
    fixture.componentRef.setInput('context', { ...CONTEXT, repo: 'acme/site', repoOwner: 'acme' });
    await fixture.whenStable();

    expect(step('owner').textContent).toContain('Владелец acme/site — acme, а подключён geeera');
  });
});
