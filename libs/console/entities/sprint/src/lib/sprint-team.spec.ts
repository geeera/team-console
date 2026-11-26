import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { TeamRunState } from '@shared/contracts';
import type { SprintRun } from './sprint.model';
import { SprintRunList } from './sprint-team';

@Component({
  imports: [SprintRunList],
  template: `<tc-sprint-run-list [runs]="runs()" [teamState]="teamState()" label="Runs" />`,
})
class Host {
  readonly runs = signal<readonly SprintRun[]>([]);
  readonly teamState = signal<TeamRunState | null>(null);
}

const run = (state: SprintRun['state'], slotName = 'morning'): SprintRun => ({
  slot: null,
  slotName,
  state,
  at: null,
});

describe('SprintRunList strip', () => {
  async function render(runs: readonly SprintRun[], teamState: TeamRunState | null = null) {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideConsoleI18n()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.runs.set(runs);
    fixture.componentInstance.teamState.set(teamState);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      root,
      stamps: () => [...root.querySelectorAll<HTMLElement>('[data-testid="run-stamp"]')],
      strip: () => root.querySelector<HTMLElement>('[data-testid="run-strip"]'),
    };
  }

  it('draws one stamp per run, in the order of the rows, each by its state', async () => {
    const { stamps } = await render([run('running'), run('finished'), run('failed'), run('unknown')]);
    expect(stamps().map((stamp) => stamp.dataset['state'])).toEqual([
      'running',
      'finished',
      'failed',
      'unknown',
    ]);
  });

  it('shows at most the five latest runs as stamps', async () => {
    const { stamps } = await render(Array.from({ length: 8 }, () => run('finished')));
    expect(stamps()).toHaveLength(5);
  });

  it('hides the stamps from assistive tech: the rows say each run in words', async () => {
    const { root } = await render([run('finished')]);
    expect(root.querySelector('.run-strip__stamps')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the breathing dot with its words only while the team is working', async () => {
    const working = await render([run('running')], 'running');
    expect(working.root.querySelector('[data-testid="team-working"]')?.textContent?.trim()).toBe('В работе');
    expect(working.root.querySelector('tc-live-dot')?.getAttribute('aria-hidden')).toBe('true');
    TestBed.resetTestingModule();

    const paused = await render([run('finished')], 'paused');
    expect(paused.root.querySelector('[data-testid="team-working"]')).toBeNull();
  });

  it('draws no strip without runs and without a working team', async () => {
    const { strip } = await render([], 'unknown');
    expect(strip()).toBeNull();
  });

  it('pauses the dot while the tab is hidden and resumes it on return', async () => {
    const { fixture, root } = await render([run('running')], 'running');
    const dot = (): Element | null => root.querySelector('tc-live-dot');
    const visibility = vi.spyOn(document, 'visibilityState', 'get');

    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    fixture.detectChanges();
    expect(dot()?.classList.contains('tc-live-dot--paused')).toBe(true);

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    fixture.detectChanges();
    expect(dot()?.classList.contains('tc-live-dot--paused')).toBe(false);
    visibility.mockRestore();
  });
});
