import { ApplicationInitStatus, type ComponentRef } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { OverviewProject } from '@console/entities/project';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import { firstValueFrom } from 'rxjs';
import { OverviewTile } from './overview-tile';

const NOW = new Date(2026, 9, 13, 10, 0, 0).getTime();

const project = (dueOn: string | null): OverviewProject => ({
  kind: 'read',
  slug: 'alpha',
  name: 'Alpha',
  team: 'running',
  sprint: dueOn === null ? null : { number: 3, title: 'Sprint 03', dueOn, planned: 8, shipped: 3 },
  needsYou: [],
  setup: false,
  snooze: { snoozed: false },
});

describe('OverviewTile demo countdown (#359)', () => {
  let fixture: ComponentFixture<OverviewTile>;
  let ref: ComponentRef<OverviewTile>;

  async function render(row: OverviewProject, index = 0): Promise<void> {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n(), provideRouter([])] });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    fixture = TestBed.createComponent(OverviewTile);
    ref = fixture.componentRef;
    ref.setInput('project', row);
    ref.setInput('now', NOW);
    ref.setInput('index', index);
    await fixture.whenStable();
  }

  const countdown = (): HTMLElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector('[data-testid="countdown"]');

  it('says how many days are left, in the right plural form', async () => {
    await render(project('2026-10-16'));
    expect(countdown()?.textContent?.trim()).toBe('До демо 3 дня');
    expect(countdown()?.classList.contains('ov__countdown--today')).toBe(false);

    ref.setInput('project', project('2026-10-14'));
    await fixture.whenStable();
    expect(countdown()?.textContent?.trim()).toBe('До демо 1 день');

    ref.setInput('project', project('2026-10-18'));
    await fixture.whenStable();
    expect(countdown()?.textContent?.trim()).toBe('До демо 5 дней');
  });

  it('on the demo day reads «Сегодня демо» in the accent', async () => {
    await render(project('2026-10-13'));
    expect(countdown()?.textContent?.trim()).toBe('Сегодня демо');
    expect(countdown()?.classList.contains('ov__countdown--today')).toBe(true);
  });

  it('follows the language', async () => {
    await render(project('2026-10-16'));
    // English is a lazy chunk (#123): loaded before the switch.
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));
    TestBed.inject(TranslocoService).setActiveLang('en');
    await fixture.whenStable();
    expect(countdown()?.textContent?.trim()).toBe('3 days to the demo');
  });

  it('shows nothing once the demo has passed, or without a sprint', async () => {
    await render(project('2026-10-12'));
    expect(countdown()).toBeNull();

    ref.setInput('project', project(null));
    await fixture.whenStable();
    expect(countdown()).toBeNull();
  });

  it('fills the meter from empty on first show, one more `--stagger` step for each next card, at most 8 steps', async () => {
    await render(project('2026-10-16'), 2);
    const meter = (fixture.nativeElement as HTMLElement).querySelector('tc-meter') as HTMLElement;
    expect(meter.querySelector('.tc-meter__fill--appear')).not.toBeNull();
    // The delay itself (`--i` x the #506 `--stagger` token) is computed in CSS; the e2e suite checks the result.
    expect(meter.style.getPropertyValue('--i')).toBe('2');

    ref.setInput('index', 30);
    await fixture.whenStable();
    expect(meter.style.getPropertyValue('--i')).toBe('8');
  });
});

describe('OverviewTile problem (#792)', () => {
  it('names the console app’s new permissions to accept instead of “GitHub didn’t respond”', async () => {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n(), provideRouter([])] });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(OverviewTile);
    fixture.componentRef.setInput('project', {
      kind: 'failed',
      slug: 'broken',
      name: 'Broken',
      problem: 'github-permission-not-accepted',
    } satisfies OverviewProject);
    fixture.componentRef.setInput('now', NOW);
    await fixture.whenStable();
    const problem = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="problem"]');
    expect(problem?.textContent?.trim()).toBe(
      'Не удалось прочитать: новые разрешения приложения консоли не приняты на GitHub',
    );
  });
});
