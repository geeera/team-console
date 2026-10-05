import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  PendingTasks,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@console/shared/i18n';
import type { RenderedMarkdown } from './rendered-markdown';

/**
 * Untrusted markdown as prose. The renderer (marked + DOMPurify) is loaded only when a `tc-markdown` is on screen, so
 * screens without one never download it; until it is there (or if it cannot load) the text shows as plain text. The
 * HTML comes only from `renderMarkdown`, and Angular's own sanitiser still runs on `[innerHTML]`; nothing here
 * bypasses it.
 */
@Component({
  selector: 'tc-markdown',
  template: `
    @if (html(); as html) {
      <div class="tc-markdown" [innerHTML]="html"></div>
    } @else {
      <p class="tc-markdown tc-markdown--plain">{{ text() }}</p>
    }
  `,
  styleUrl: './markdown.css',
  // The rendered elements carry no component attributes, so the prose styles are scoped by the class instead.
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-markdown-host' },
})
export class Markdown {
  private readonly pendingTasks = inject(PendingTasks);

  readonly text = input.required<string>();
  /** Every render's result, for callers that need the links (the preview of a design or demo card). */
  readonly rendered = output<RenderedMarkdown>();

  protected readonly html = signal<string | null>(null);
  private readonly imageLabel = toSignal(inject(TranslocoService).selectTranslate('ui.markdown.image'), {
    initialValue: '',
  });
  private renderToken = 0;

  constructor() {
    effect(() => {
      const text = this.text();
      const imageLabel = this.imageLabel();
      untracked(() => {
        void this.pendingTasks.run(() => this.render(text, imageLabel));
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.renderToken += 1;
    });
  }

  private async render(text: string, imageLabel: string): Promise<void> {
    const token = ++this.renderToken;
    let renderer: typeof import('./render-markdown');
    try {
      renderer = await import('./render-markdown');
    } catch (error: unknown) {
      // A chunk that cannot load (offline, a stale deploy) leaves the plain text, which is safe to read.
      console.warn('markdown: renderer unavailable, showing plain text', error);
      return;
    }
    if (token !== this.renderToken) {
      return;
    }
    const result = renderer.renderMarkdown(text, { imageLabel });
    this.html.set(result.html);
    this.rendered.emit(result);
  }
}
