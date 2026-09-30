import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Navigation between the sections of one screen: a segmented row by default, a bottom bar
 * (`bottom`) on the phone with the safe-area inset. It is a `<nav>` of links, so give it an
 * `aria-label`; the current section carries `aria-current="page"`.
 *
 * ```html
 * <nav tc-tab-bar bottom [attr.aria-label]="t('space.sections')">
 *   <a tc-tab routerLink="chat" [current]="section() === 'chat'"><tc-icon name="chat" />{{ t('chat') }}</a>
 * </nav>
 * ```
 */
@Component({
  selector: 'nav[tc-tab-bar]',
  template: '<ng-content />',
  styleUrl: './tab-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-tab-bar',
    '[class.tc-tab-bar--bottom]': 'bottom()',
  },
})
export class TabBar {
  /** Fixed to the bottom edge with icons above labels, as the phone layout wants. */
  readonly bottom = input(false, { transform: booleanAttribute });
}

/** One section link inside `tc-tab-bar`; an anchor, so the router and the browser both understand it. */
@Component({
  selector: 'a[tc-tab]',
  template: '<ng-content />',
  styleUrl: './tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-tab',
    '[attr.aria-current]': 'current() ? "page" : null',
  },
})
export class Tab {
  readonly current = input(false, { transform: booleanAttribute });
}
