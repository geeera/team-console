import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';
import { renderMarkdown } from './render-markdown';

/**
 * Untrusted markdown as prose. The HTML comes only from `renderMarkdown` (DOMPurify), and Angular's own sanitiser
 * still runs on `[innerHTML]`; nothing here bypasses it.
 */
@Component({
  selector: 'tc-markdown',
  template: `<div class="tc-markdown" [innerHTML]="html()"></div>`,
  styleUrl: './markdown.css',
  // The rendered elements carry no component attributes, so the prose styles are scoped by the class instead.
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-markdown-host' },
})
export class Markdown {
  readonly text = input.required<string>();

  protected readonly html = computed(() => renderMarkdown(this.text()).html);
}
