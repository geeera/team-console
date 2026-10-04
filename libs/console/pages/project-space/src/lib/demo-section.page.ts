import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { EmbedOriginsApi, ProjectsStore } from '@console/entities/project';
import { TranslocoPipe } from '@console/shared/i18n';
import { StateBlock } from '@console/shared/ui';
import { QuestionList } from '@console/widgets/question-list';
import type { NeedsYouProjectRef, Section } from '@shared/contracts';
import { map } from 'rxjs';

// The plugin's two owner sections this screen answers (#20): `design:awaiting-approval` and the open `team:demo`.
const REVIEW_SECTIONS: readonly Section[] = ['release', 'design'];

type OriginsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly origins: readonly string[] }
  | { readonly kind: 'failed' };

/**
 * `/p/:slug/demo` (#20): designs waiting for approval and the open demo issue, answered in place through the same
 * cards and answer route as Questions (#10, #16). Bodies render as sanitised markdown; a body's page is framed only
 * on one of the project's embed origins. If those cannot be read, every preview is a link instead.
 */
@Component({
  selector: 'tc-demo-section-page',
  imports: [QuestionList, StateBlock, TranslocoPipe],
  template: `
    <p class="demo__lead">{{ 'review.lead' | transloco }}</p>
    @switch (origins().kind) {
      @case ('loading') {
        <tc-state-block kind="loading" />
      }
      @default {
        @if (origins().kind === 'failed') {
          <p class="demo__note" data-testid="origins-failed">{{ 'review.originsFailed' | transloco }}</p>
        }
        @if (project(); as project) {
          <tc-question-list
            [project]="project"
            [sections]="sections"
            [embedOrigins]="embedOrigins()"
            [listLabel]="'review.listLabel' | transloco"
            [emptyTitle]="'review.emptyTitle' | transloco"
            [emptyHint]="'review.emptyHint' | transloco"
          />
        }
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-4);
    }

    .demo__lead,
    .demo__note {
      margin: 0;
      color: var(--text-2);
      font-size: var(--fs-sm);
    }

    .demo__note {
      padding: var(--space-2) var(--space-3);
      border-radius: var(--r-md);
      background: var(--warning-soft);
      color: var(--warning-text);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DemoSectionPage {
  private readonly projects = inject(ProjectsStore);
  private readonly route = inject(ActivatedRoute);
  private readonly embedOriginsApi = inject(EmbedOriginsApi);

  protected readonly sections = REVIEW_SECTIONS;
  protected readonly origins = signal<OriginsState>({ kind: 'loading' });
  protected readonly embedOrigins = computed(() => {
    const state = this.origins();
    return state.kind === 'ready' ? state.origins : [];
  });

  private readonly slug = toSignal(
    (this.route.parent ?? this.route).paramMap.pipe(map((params) => params.get('slug'))),
    { initialValue: null },
  );

  // Equal by value: a registry refresh must not reload the list it feeds.
  protected readonly project = computed<NeedsYouProjectRef | null>(
    () => {
      const slug = this.slug();
      const found = slug === null ? undefined : this.projects.bySlug(slug);
      return found === undefined ? null : { slug: found.slug, name: found.displayName };
    },
    { equal: (a, b) => a?.slug === b?.slug && a?.name === b?.name },
  );

  private loadToken = 0;

  constructor() {
    effect(() => {
      const slug = this.project()?.slug ?? null;
      untracked(() => {
        if (slug !== null) {
          void this.loadOrigins(slug);
        }
      });
    });
  }

  private async loadOrigins(slug: string): Promise<void> {
    const token = ++this.loadToken;
    this.origins.set({ kind: 'loading' });
    try {
      const origins = await this.embedOriginsApi.origins(slug);
      if (token === this.loadToken) {
        this.origins.set({ kind: 'ready', origins });
      }
    } catch (error: unknown) {
      // Unknown origins frame nothing: the cards still list and answer, previews become links, and the note says why.
      if (token === this.loadToken) {
        console.warn('embed origins unavailable', error);
        this.origins.set({ kind: 'failed' });
      }
    }
  }
}
