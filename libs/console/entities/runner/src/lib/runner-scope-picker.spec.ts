import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { RunnerProjectScope } from '@shared/contracts';
import { RunnerScopePicker } from './runner-scope-picker';

@Component({
  imports: [RunnerScopePicker],
  template: `<tc-runner-scope-picker
    legend="Scope"
    projectsLegend="Projects"
    [projects]="projects"
    [(scope)]="scope"
    [(selected)]="selected"
    [ownerCount]="ownerCount()"
  />`,
})
class Host {
  projects = [
    { slug: 'team-console', displayName: 'Team Console' },
    { slug: 'storify', displayName: 'Storify' },
  ];
  scope: RunnerProjectScope = 'all';
  selected: readonly string[] = ['team-console'];
  readonly ownerCount = signal<number | null>(null);
}

describe('RunnerScopePicker (#775)', () => {
  async function render() {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n()] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const radio = (scope: RunnerProjectScope): HTMLInputElement =>
      root.querySelector(`[data-testid="runner-scope-${scope}"]`) as HTMLInputElement;
    const pick = async (scope: RunnerProjectScope): Promise<void> => {
      radio(scope).checked = true;
      radio(scope).dispatchEvent(new Event('change'));
      await fixture.whenStable();
    };
    return { fixture, root, radio, pick };
  }

  it('offers the two scopes as one radio group with plain words, the project list only under selected', async () => {
    const { root, radio, pick, fixture } = await render();
    expect(root.querySelector('fieldset legend')?.textContent?.trim()).toBe('Scope');
    expect(radio('all').checked).toBe(true);
    expect(radio('all').name).toBe(radio('selected').name);
    expect(root.textContent).toContain('Все проекты аккаунта');
    expect(root.textContent).toContain('Все текущие и будущие проекты аккаунта');
    expect(root.textContent).toContain('Только выбранные');
    expect(root.querySelector('tc-runner-projects-picker')).toBeNull();

    await pick('selected');
    expect(fixture.componentInstance.scope).toBe('selected');
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    boxes[1]?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.selected).toEqual(['team-console', 'storify']);

    // Back to `all`: the list is hidden but kept, so switching again restores it.
    await pick('all');
    expect(root.querySelector('tc-runner-projects-picker')).toBeNull();
    expect(fixture.componentInstance.selected).toEqual(['team-console', 'storify']);
  });

  it('describes each option by its hint for assistive technology', async () => {
    const { root, radio } = await render();
    for (const scope of ['all', 'selected'] as const) {
      for (const hintId of (radio(scope).getAttribute('aria-describedby') ?? '').split(' ')) {
        expect(root.querySelector(`#${hintId}`)?.textContent?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('states D3 unless the account is known to have one owner (N6, decision 5)', async () => {
    const { root, fixture, radio } = await render();
    const owners = (): Element | null => root.querySelector('[data-testid="runner-scope-owners"]');
    // Unknown count: the conditional wording, which never claims owners the account may not have (#878).
    expect(owners()?.textContent).toContain('Если в аккаунте есть другие владельцы');
    expect(owners()?.textContent).not.toContain('несколько владельцев');
    expect(radio('all').getAttribute('aria-describedby')).toContain(owners()?.id ?? 'missing');

    fixture.componentInstance.ownerCount.set(1);
    await fixture.whenStable();
    expect(owners()).toBeNull();

    fixture.componentInstance.ownerCount.set(2);
    await fixture.whenStable();
    expect(owners()?.textContent).toContain('В аккаунте несколько владельцев');
  });
});
