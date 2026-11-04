import { computed, inject, Injectable, signal } from '@angular/core';
import { AnsweredItems } from '@console/entities/project';
import { batchCandidatesOf, QuestionsApi, type QuestionItem } from '@console/entities/question';
import type { NeedsYouProjectRef } from '@shared/contracts';

/** The Approve team recommendations row (#246): not read yet, unreadable, or what the batch would take. */
export type ProjectBatchView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly count: number; readonly leftOut: number };

/**
 * One project's waiting items as the Commands panel's batch row reads them (#246): the project's questions, minus
 * what this device already answered — the same rule Needs you applies to its cards, so the row's count and the
 * Needs you button agree for that project. Provided per panel.
 */
@Injectable()
export class ProjectBatch {
  private readonly api = inject(QuestionsApi);
  private readonly answeredItems = inject(AnsweredItems);

  private readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  private readonly items = signal<readonly QuestionItem[]>([]);
  private loadToken = 0;

  /** The items still waiting for an answer from this device, once read. */
  readonly waiting = computed<readonly QuestionItem[]>(() =>
    this.state() === 'ready'
      ? this.items().filter((item) => !this.answeredItems.has(item.project.slug, item.number))
      : [],
  );

  readonly view = computed<ProjectBatchView>(() => {
    const state = this.state();
    if (state !== 'ready') {
      return { kind: state };
    }
    const { candidates, leftOut } = batchCandidatesOf(this.waiting());
    return { kind: 'ready', count: candidates.length, leftOut: leftOut.length };
  });

  /** Reads the project's questions again; a failed re-read keeps what was read before. */
  async load(project: NeedsYouProjectRef): Promise<void> {
    const token = ++this.loadToken;
    try {
      const items = await this.api.projectQuestions(project);
      if (token !== this.loadToken) {
        return;
      }
      this.items.set(items);
      this.answeredItems.reconcile(
        [project.slug],
        items.map((item) => ({ slug: item.project.slug, number: item.number })),
      );
      this.state.set('ready');
    } catch (error: unknown) {
      if (token !== this.loadToken) {
        return;
      }
      // HttpErrorResponse or an unexpected shape alike: the row says the questions could not be read.
      console.warn('commands panel: project questions not read', error);
      if (this.state() !== 'ready') {
        this.state.set('error');
      }
    }
  }

  /** Another project was opened in the same panel: nothing of the last one is shown. */
  reset(): void {
    this.loadToken += 1;
    this.items.set([]);
    this.state.set('loading');
  }
}
