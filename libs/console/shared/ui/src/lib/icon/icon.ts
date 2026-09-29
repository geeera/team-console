import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Stroke glyphs drawn on a 24-unit grid; the set grows only when a screen needs a new one. */
const GLYPHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  minus: 'M6 12h12',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  alert: 'M12 8v5M12 16.5v.5M10.3 3.9L2.7 17.2A2 2 0 004.4 20h15.2a2 2 0 001.7-2.8L13.7 3.9a2 2 0 00-3.4 0z',
  inbox: 'M3 13l2.5-8h13L21 13M3 13v6h18v-6M3 13h5l1.5 3h5L16 13h5',
  search: 'M10.5 18a7.5 7.5 0 100-15 7.5 7.5 0 000 15zM21 21l-5-5',
  plus: 'M12 5v14M5 12h14',
  settings:
    'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  github:
    'M15 22v-4a3.5 3.5 0 00-1-2.5c3-.3 6-1.5 6-6.5a5 5 0 00-1.4-3.5 4.6 4.6 0 00-.1-3.5s-1.1-.3-3.5 1.3a12 12 0 00-6 0C6.6 1.7 5.5 2 5.5 2a4.6 4.6 0 00-.1 3.5A5 5 0 004 9c0 5 3 6.2 6 6.5a3.5 3.5 0 00-1 2.5v4M9 18c-4.5 1.5-4.5-2.5-6-3',
} as const;

export type IconName = keyof typeof GLYPHS;
export type IconSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * Decorative by default (`aria-hidden`); pass `label` when the icon carries meaning on its own
 * (an icon-only button already has its `aria-label`, so leave it decorative there).
 */
@Component({
  selector: 'tc-icon',
  template: `<svg viewBox="0 0 24 24" focusable="false"><path [attr.d]="path()" /></svg>`,
  styleUrl: './icon.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-icon',
    '[class.tc-icon--sm]': 'size() === "sm"',
    '[class.tc-icon--lg]': 'size() === "lg"',
    '[class.tc-icon--xl]': 'size() === "xl"',
    '[attr.role]': 'label() ? "img" : null',
    '[attr.aria-label]': 'label() || null',
    '[attr.aria-hidden]': 'label() ? null : "true"',
  },
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input<IconSize>('md');
  readonly label = input<string>('');

  protected readonly path = computed(() => GLYPHS[this.name()]);
}
