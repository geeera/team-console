import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { RunnerDto } from '@shared/contracts';
import { RunnerCard } from './runner-card';
import { runnerFixture } from './runner.fixture';
import { RunnerProjectsPicker } from './runner-projects-picker';

@Component({
  imports: [RunnerCard],
  template: `<tc-runner-card [runner]="runner()" [minimumVersion]="minimum()">
    <button tc-runner-actions type="button">Act</button>
  </tc-runner-card>`,
})
class Host {
  readonly runner = input.required<RunnerDto>();
  readonly minimum = input<string | null>(null);
}

async function render(runner: RunnerDto, minimum: string | null = null): Promise<HTMLElement> {
  TestBed.configureTestingModule({ providers: [provideConsoleI18n()] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentRef.setInput('runner', runner);
  fixture.componentRef.setInput('minimum', minimum);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

const text = (root: HTMLElement, id: string): string =>
  root.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? '';

describe('RunnerCard', () => {
  it('shows name, presence, backend, version, last seen, host and projects', async () => {
    const root = await render(runnerFixture());
    const card = root.querySelector('article');
    expect(card?.getAttribute('aria-labelledby')).toBe(root.querySelector('h3')?.id);
    expect(root.querySelector('h3')?.textContent?.trim()).toBe('Mac');
    expect(text(root, 'runner-presence')).toBe('На связи');
    expect(root.textContent).toContain('Отдельный пользователь macOS');
    expect(text(root, 'runner-version')).toBe('0.2.0');
    expect(root.querySelector('[data-testid="runner-last-seen"]')?.getAttribute('datetime')).toBe(
      '2026-11-11T09:58:00.000Z',
    );
    expect(text(root, 'runner-last-seen')).toMatch(/11 ноября, \d{2}:\d{2}/);
    expect(root.textContent).toContain('mac.local · darwin/arm64');
    expect(text(root, 'runner-projects')).toBe('team-console');
    expect(root.querySelector('[data-testid="runner-behind"]')).toBeNull();
    expect(root.textContent).toContain('Act');
  });

  it('flags a version below the minimum and quotes the minimum', async () => {
    const root = await render(runnerFixture({ version: '0.1.0', belowMinimum: true }), '0.2.0');
    expect(text(root, 'runner-behind')).toBe('Ниже минимальной версии');
    expect(root.textContent).toContain('минимальная 0.2.0 — обновите раннер');
  });

  it('says offline, never seen, suspect and revoked in words', async () => {
    expect(text(await render(runnerFixture({ online: false })), 'runner-presence')).toBe('Не на связи');
    TestBed.resetTestingModule();
    const never = await render(runnerFixture({ online: false, lastSeenAt: null }));
    expect(text(never, 'runner-presence')).toBe('Ещё не выходил на связь');
    expect(never.textContent).toContain('ещё не выходил на связь');
    TestBed.resetTestingModule();
    const suspect = await render(
      runnerFixture({ suspect: { at: '2026-11-11T09:00:00.000Z', reason: 'new-country' } }),
    );
    expect(text(suspect, 'runner-presence')).toBe('Требует проверки');
    expect(text(suspect, 'runner-suspect')).toContain('из новой страны');
    TestBed.resetTestingModule();
    const revoked = await render(
      runnerFixture({ revokedAt: '2026-11-11T09:30:00.000Z', belowMinimum: true, online: false }),
    );
    expect(text(revoked, 'runner-presence')).toBe('Отозван');
    // A revoked runner is not asked to update.
    expect(revoked.querySelector('[data-testid="runner-behind"]')).toBeNull();
  });

  it('says a runner with no projects takes no jobs', async () => {
    expect(text(await render(runnerFixture({ allowedProjects: [] })), 'runner-projects')).toBe(
      'ни одного — раннер не возьмёт задания',
    );
  });
});

describe('RunnerProjectsPicker', () => {
  @Component({
    imports: [RunnerProjectsPicker],
    template: `<tc-runner-projects-picker legend="Projects" [projects]="projects" [(selected)]="selected" />`,
  })
  class PickerHost {
    projects = [
      { slug: 'team-console', displayName: 'Team Console' },
      { slug: 'storify', displayName: 'Storify' },
    ];
    selected: readonly string[] = ['team-console', 'archived-one'];
  }

  it('ticks and unticks projects, keeping a slug it does not list', async () => {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n()] });
    const fixture = TestBed.createComponent(PickerHost);
    await fixture.whenStable();
    const boxes = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    boxes[1]?.click();
    boxes[0]?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.selected).toEqual(['archived-one', 'storify']);
  });

  it('says so when the account has no project', async () => {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n()] });
    const fixture = TestBed.createComponent(PickerHost);
    fixture.componentInstance.projects = [];
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('В аккаунте нет активных проектов.');
  });
});
