import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { SprintCiState } from '@shared/contracts';
import { SprintCiChip } from './sprint-ci';
import { SprintCiMemory } from './sprint-ci-memory';

@Component({
  imports: [SprintCiChip],
  template: `<tc-sprint-ci-chip [state]="state()" [memoryKey]="key()" />`,
})
class Host {
  readonly state = signal<SprintCiState>('pending');
  readonly key = signal<string | null>(null);
}

describe('SprintCiChip painting', () => {
  async function render(
    state: SprintCiState,
    key: string | null = null,
    seen: readonly [string, SprintCiState][] = [],
  ) {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideConsoleI18n()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    for (const [seenKey, seenState] of seen) {
      TestBed.inject(SprintCiMemory).remember(seenKey, seenState);
    }
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.state.set(state);
    fixture.componentInstance.key.set(key);
    await fixture.whenStable();
    const host = (): HTMLElement => fixture.nativeElement.querySelector('tc-sprint-ci-chip');
    const change = async (next: SprintCiState): Promise<void> => {
      fixture.componentInstance.state.set(next);
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const isPainting = (): boolean => host().classList.contains('sprint-ci-chip--painting');
    return { fixture, host, change, isPainting };
  }

  it('paints when a running check turns into a passed one while the chip is on screen', async () => {
    const { change, isPainting } = await render('pending');
    expect(isPainting()).toBe(false);
    await change('success');
    expect(isPainting()).toBe(true);
  });

  it('stops painting once the halo ends', async () => {
    const { fixture, change, isPainting } = await render('pending');
    await change('success');
    (fixture.nativeElement.querySelector('tc-chip') as HTMLElement).dispatchEvent(new Event('animationend'));
    fixture.detectChanges();
    expect(isPainting()).toBe(false);
  });

  it('does not paint on the first render, even when passed', async () => {
    const { isPainting } = await render('success');
    expect(isPainting()).toBe(false);
  });

  it.each<[SprintCiState, SprintCiState]>([
    ['pending', 'failure'],
    ['none', 'success'],
    ['failure', 'success'],
    ['success', 'pending'],
  ])('does not paint for %s to %s', async (from, to) => {
    const { change, isPainting } = await render(from);
    await change(to);
    expect(isPainting()).toBe(false);
  });

  it('puts a fill disc behind the icon, hidden from assistive tech, and keeps the words', async () => {
    const { host } = await render('success');
    expect(host().querySelector('.sprint-ci__fill')?.getAttribute('aria-hidden')).toBe('true');
    expect(host().querySelector('tc-icon')).not.toBeNull();
    expect(host().textContent?.trim()).toBe('CI пройден');
  });

  it('paints on arrival when the pull request last showed running (the board reloaded whole)', async () => {
    const { isPainting } = await render('success', 'team-console#92', [['team-console#92', 'pending']]);
    expect(isPainting()).toBe(true);
  });

  it('does not paint on arrival for a pull request the owner has not seen, or in another project', async () => {
    const { isPainting } = await render('success', 'team-console#92', [['other#92', 'pending']]);
    expect(isPainting()).toBe(false);
  });
});
