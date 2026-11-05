import { DIALOG_DATA } from '@angular/cdk/dialog';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { Icon, type IconName } from '../icon/icon';

/** One choice. `off` is the visible reason it cannot be picked now; the item still takes focus and says why. */
export interface MenuItem {
  readonly id: string;
  readonly label: string;
  /** A second line: "5 tasks · demo Nov 27". */
  readonly hint?: string;
  /** `warning`: the hint is a caution ("Already 9 tasks…"), not a block. */
  readonly hintTone?: 'warning';
  readonly off?: string;
  /** The current value of a picker (`menuitemradio`), or "it's here now". */
  readonly checked?: boolean;
  readonly icon?: IconName;
}

export interface MenuGroup {
  /** A small-caps heading over the group; groups are split by a rule. */
  readonly label?: string;
  readonly items: readonly MenuItem[];
}

export interface MenuSpec {
  /** The menu's accessible name ("Move TC-408"); on the phone also the sheet's title. */
  readonly label: string;
  /** Shown over the items in the popover: "TC-408 · where to move it". */
  readonly title?: string;
  readonly subtitle?: string;
  /** A note over the items ("The task is in progress…"). */
  readonly warning?: string;
  readonly groups: readonly MenuGroup[];
  /** Pickers: the items are `menuitemradio` and focus starts on the checked one. */
  readonly radio?: boolean;
}

export interface MenuPanelData {
  readonly spec: MenuSpec;
  readonly presentation: 'popover' | 'sheet';
  readonly close: (id: string | null) => void;
}

let nextMenuId = 0;

/**
 * The body of `Menu` (#409): `role="menu"` with `menuitem`s (or `menuitemradio`s for a picker). Focus goes to the
 * checked item, else the first one that can be picked; ↑ ↓ Home End move (wrapping), Enter or Space picks, Escape
 * closes without a change. An off item keeps its place and focus; picking it announces its reason instead.
 */
@Component({
  selector: 'tc-menu-panel',
  imports: [Icon],
  templateUrl: './menu-panel.html',
  styleUrl: './menu-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-menu',
    '[class.tc-menu--sheet]': 'isSheet',
    '(keydown)': 'onKeydown($event)',
  },
})
export class MenuPanel {
  protected readonly data = inject<MenuPanelData>(DIALOG_DATA);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly spec = this.data.spec;
  protected readonly isSheet = this.data.presentation === 'sheet';
  protected readonly id = `tc-menu-${nextMenuId++}`;
  /** The reason of the off item just picked, read out politely. */
  protected readonly announced = signal('');

  constructor() {
    afterNextRender(() => this.focusStart(), { injector: inject(Injector) });
  }

  protected hintId(group: number, item: number): string {
    return `${this.id}-h${String(group)}-${String(item)}`;
  }

  protected pick(item: MenuItem): void {
    if (item.off !== undefined) {
      // Re-announce even when the same item is picked twice.
      this.announced.set('');
      queueMicrotask(() => this.announced.set(item.off ?? ''));
      return;
    }
    this.data.close(item.id);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const items = this.items();
    if (items.length === 0) {
      return;
    }
    const current = items.indexOf(event.target as HTMLElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = current < 0 ? 0 : (current + 1) % items.length;
        break;
      case 'ArrowUp':
        next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.data.close(null);
        return;
      case 'Tab':
        // A menu is one stop: Tab leaves it, as Escape does.
        if (!this.isSheet) {
          event.preventDefault();
          this.data.close(null);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  private items(): HTMLElement[] {
    return Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('.tc-menu__item'));
  }

  private focusStart(): void {
    const items = this.items();
    const checked = this.spec.radio
      ? items.find((item) => item.getAttribute('aria-checked') === 'true')
      : undefined;
    const enabled = items.find((item) => item.getAttribute('aria-disabled') !== 'true');
    (checked ?? enabled ?? items[0])?.focus();
  }
}
