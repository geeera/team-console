import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { IconName } from '../icon/icon';
import { StateBlock, StateKind } from './state-block';

@Component({
  imports: [StateBlock],
  template: `<tc-state-block
    [kind]="kind()"
    [title]="title()"
    [icon]="icon()"
    [stamp]="stamp()"
    [pressed]="pressed()"
    [compact]="compact()"
  />`,
})
class Host {
  readonly kind = signal<StateKind>('loading');
  readonly title = signal('');
  readonly icon = signal<IconName | null>(null);
  readonly stamp = signal('');
  readonly pressed = signal(false);
  readonly compact = signal(false);
}

describe('StateBlock', () => {
  async function render() {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideConsoleI18n()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const block = (fixture.nativeElement as HTMLElement).querySelector('tc-state-block') as HTMLElement;
    const title = () => block.querySelector('.tc-state-block__title')?.textContent?.trim();
    return { fixture, block, title };
  }

  it('is a polite live region with the kit copy while loading', async () => {
    const { block, title } = await render();

    expect(block.getAttribute('role')).toBe('status');
    expect(block.getAttribute('aria-live')).toBe('polite');
    expect(block.getAttribute('aria-busy')).toBe('true');
    expect(block.querySelector('tc-spinner')).not.toBeNull();
    expect(title()).toBe('Загрузка…');
  });

  it('is an alert with the kit copy on error', async () => {
    const { fixture, block, title } = await render();

    fixture.componentInstance.kind.set('error');
    await fixture.whenStable();

    expect(block.getAttribute('role')).toBe('alert');
    expect(block.getAttribute('aria-live')).toBeNull();
    expect(title()).toBe('Что-то пошло не так');
  });

  it('prefers the title the caller passes', async () => {
    const { fixture, block, title } = await render();

    fixture.componentInstance.kind.set('empty');
    fixture.componentInstance.title.set('Ничего не ждёт');
    await fixture.whenStable();

    expect(block.getAttribute('role')).toBeNull();
    expect(title()).toBe('Ничего не ждёт');
  });

  it("shows the glyph the caller picks instead of the kind's, and the kind's again without one", async () => {
    const { fixture, block } = await render();
    const glyph = () => block.querySelector('tc-icon path')?.getAttribute('d');

    fixture.componentInstance.kind.set('empty');
    await fixture.whenStable();
    const check = glyph();
    fixture.componentInstance.icon.set('question');
    await fixture.whenStable();
    const question = glyph();

    expect(check).toBeTruthy();
    expect(question).toBeTruthy();
    expect(question).not.toBe(check);
    expect(block.classList.contains('tc-state-block--custom-icon')).toBe(true);
    expect(block.getAttribute('role')).toBeNull();

    fixture.componentInstance.icon.set(null);
    await fixture.whenStable();
    expect(glyph()).toBe(check);
  });

  describe('clear desk (#354)', () => {
    async function desk() {
      const view = await render();
      view.fixture.componentInstance.kind.set('empty');
      view.fixture.componentInstance.title.set('The desk is clear');
      view.fixture.componentInstance.stamp.set('All decided');
      await view.fixture.whenStable();
      const stamp = () => view.block.querySelector<HTMLElement>('[data-testid="desk-stamp"]');
      return { ...view, stamp };
    }

    it('shows the stamp words above the title, in place of the glyph, on a sheet', async () => {
      const { block, stamp, title } = await desk();
      expect(stamp()?.textContent?.trim()).toBe('All decided');
      expect(title()).toBe('The desk is clear');
      expect(block.querySelector('tc-icon')).toBeNull();
      expect(block.classList.contains('tc-state-block--desk')).toBe(true);
      expect(stamp()?.nextElementSibling?.classList.contains('tc-state-block__title')).toBe(true);
    });

    it('is there already unless the caller says the list just emptied', async () => {
      const { fixture, stamp } = await desk();
      expect(stamp()?.classList.contains('tc-state-block__stamp--pressed')).toBe(false);

      fixture.componentInstance.pressed.set(true);
      await fixture.whenStable();
      expect(stamp()?.classList.contains('tc-state-block__stamp--pressed')).toBe(true);
    });

    it('stays the ordinary empty block without stamp words, compact, or in another kind', async () => {
      const { fixture, block, stamp } = await desk();
      fixture.componentInstance.stamp.set('');
      await fixture.whenStable();
      expect(stamp()).toBeNull();
      expect(block.querySelector('tc-icon')).not.toBeNull();
      expect(block.classList.contains('tc-state-block--desk')).toBe(false);

      fixture.componentInstance.stamp.set('All decided');
      fixture.componentInstance.compact.set(true);
      await fixture.whenStable();
      expect(stamp()).toBeNull();

      fixture.componentInstance.compact.set(false);
      fixture.componentInstance.kind.set('error');
      await fixture.whenStable();
      expect(stamp()).toBeNull();
    });
  });
});
