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
  // The spaces shell (#23): pinned projects, the overview grid and the section tabs.
  pin: 'M9 4h6l-1 5 3 3H7l3-3zM12 12v8',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  chat: 'M4 5h16v11H9l-5 4z',
  board: 'M4 4h16v16H4zM9 4v16M15 4v16',
  stack: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  play: 'M7 4l12 8-12 8z',
  // Settings (#24): archive a project, external GitHub links, copy a command, the connection and offline states.
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.2M12 17v.5',
  offline: 'M2 8.5a15 15 0 0120 0M5.5 12a10 10 0 0113 0M9 15.5a5 5 0 016 0M12 19v.5M3 3l18 18',
  // The sprint board (#18): the demo date.
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v5M16 3v5',
  // Team commands (#114): the Commands entry, pause, refresh, a run's clock, a missing key, no write access.
  sliders: 'M5 7h8M17 7h2M5 17h2M11 17h8M15 9a2 2 0 100-4 2 2 0 000 4zM9 19a2 2 0 100-4 2 2 0 000 4z',
  pause: 'M9 6v12M15 6v12',
  refresh: 'M19.5 12a7.5 7.5 0 11-2.2-5.3M19.5 4.5V9H15',
  clock: 'M12 20a8 8 0 100-16 8 8 0 000 16zM12 7.5V12l3 2',
  key: 'M8 18.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM10.5 12.5l8-8M16 7l2.5 2.5M14 9l2 2',
  lock: 'M7 10.5h10a2 2 0 012 2V18a2 2 0 01-2 2H7a2 2 0 01-2-2v-5.5a2 2 0 012-2zM8.5 10.5V8a3.5 3.5 0 017 0v2.5',
  question: 'M9.3 9a2.8 2.8 0 015.4 1c0 2-2.7 2.3-2.7 4M12 17.3v.2',
  // Issue tiers (#134): a three-step meter; an empty step is a baseline dash, so the bar count alone tells the tier.
  'tier-light': 'M5 14h2v6H5zM11 20h2M17 20h2',
  'tier-standard': 'M5 14h2v6H5zM11 9h2v11h-2zM17 20h2',
  'tier-heavy': 'M5 14h2v6H5zM11 9h2v11h-2zM17 4h2v16h-2z',
  // Web push (#36): the Notifications block, its nudge, and Safari's own buttons in the Home Screen guide.
  bell: 'M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15zM10 20.5a2 2 0 004 0',
  'bell-off': 'M8.2 6.2A6 6 0 0118 11v3.5M6 11v5.5l-1.5 2h12M10 20.5a2 2 0 004 0M4 4l16 16',
  share: 'M12 3.5v11M8 7.5l4-4 4 4M8.5 10.5h-2a1 1 0 00-1 1v8a1 1 0 001 1h11a1 1 0 001-1v-8a1 1 0 00-1-1h-2',
  // Safari's "More": three dots drawn as small rings, so the one stroke width still reads as solid dots.
  more: 'M6.5 11.2a.8.8 0 110 1.6.8.8 0 010-1.6zM12 11.2a.8.8 0 110 1.6.8.8 0 010-1.6zM17.5 11.2a.8.8 0 110 1.6.8.8 0 010-1.6z',
  'add-square': 'M8 4.5h8A3.5 3.5 0 0119.5 8v8a3.5 3.5 0 01-3.5 3.5H8A3.5 3.5 0 014.5 16V8A3.5 3.5 0 018 4.5zM12 8.5v7M8.5 12h7',
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
