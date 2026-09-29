import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The screen header: a leading slot (back, project switcher), a serif title, trailing actions.
 * Pads for the iPhone notch through the safe-area tokens. Use it on a `<header>` so the
 * landmark is the browser's; the title element (`h1`/`h2`) is the caller's choice.
 *
 * ```html
 * <header tc-top-bar>
 *   <button tc-icon-button tc-top-bar-leading [attr.aria-label]="t('ui.back')"><tc-icon name="chevron-left" /></button>
 *   <h1 tc-top-bar-title>Settings</h1>
 *   <button tc-icon-button tc-top-bar-trailing [attr.aria-label]="t('search')"><tc-icon name="search" /></button>
 * </header>
 * ```
 */
@Component({
  selector: 'header[tc-top-bar], div[tc-top-bar]',
  template: `
    <div class="tc-top-bar__leading"><ng-content select="[tc-top-bar-leading]" /></div>
    <div class="tc-top-bar__title"><ng-content select="[tc-top-bar-title]" /></div>
    <div class="tc-top-bar__trailing"><ng-content select="[tc-top-bar-trailing]" /></div>
  `,
  styleUrl: './top-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-top-bar',
    '[class.tc-top-bar--sticky]': 'sticky()',
  },
})
export class TopBar {
  readonly sticky = input(false, { transform: booleanAttribute });
}
