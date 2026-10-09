import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { ArtifactList, ArtifactsStore, type Artifact } from '@console/entities/artifact';
import { DesignManifests, DesignPreview, DesignSummary } from '@console/entities/design';
import {
  ARTIFACT_QUERY_MAX_LENGTH,
  ArtifactSearch,
  filterArtifacts,
} from '@console/features/artifact-search';
import { DesignViewer } from '@console/features/design-viewer';
import { localTimeOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { PersistedStateStore } from '@console/shared/persisted-state';
import { Button, Callout, StateBlock } from '@console/shared/ui';
import { isArtifactType, type ArtifactType } from '@shared/contracts';
import { map } from 'rxjs';

/**
 * `/p/:slug/artifacts` (#19): the project's decisions, designs and demos with type toggles and a search over the
 * loaded list. The filter lives in the URL (`?type=&q=`, replaced, not pushed) and in the device's UI state, so a
 * return to the space restores it; "Check again" asks the Worker to skip its cache.
 */
@Component({
  selector: 'tc-artifacts-section-page',
  imports: [ArtifactList, ArtifactSearch, Button, Callout, DesignPreview, DesignSummary, StateBlock, TranslocoPipe],
  template: `
    <div class="artifacts__head">
      <h2 class="artifacts__title">{{ 'artifacts.title' | transloco }}</h2>
      @if (snapshot(); as snapshot) {
        <p class="artifacts__loaded" data-testid="artifacts-loaded">
          {{ 'artifacts.loadedAt' | transloco: { time: loadedTime() } }}
        </p>
        <button
          tc-button
          size="sm"
          type="button"
          data-testid="artifacts-check-again"
          [loading]="refreshing()"
          (click)="checkAgain()"
        >
          {{ 'artifacts.checkAgain' | transloco }}
        </button>
      }
    </div>

    @switch (state().kind) {
      @case ('failed') {
        @if (failure(); as failure) {
          <tc-state-block
            kind="error"
            data-testid="artifacts-error"
            [attr.data-failure]="failure"
            [title]="'artifacts.error.' + failure + '.title' | transloco"
            [description]="'artifacts.error.' + failure + '.hint' | transloco"
          >
            <button tc-button tc-state-action type="button" (click)="reload()">
              {{ 'ui.error.retry' | transloco }}
            </button>
          </tc-state-block>
        }
      }
      @case ('ready') {
        @if (snapshot(); as snapshot) {
          @if (snapshot.partial.length > 0) {
            <section
              tc-callout
              tone="warning"
              data-testid="artifacts-partial"
              aria-labelledby="tc-artifacts-partial"
            >
              <h3 tc-callout-title id="tc-artifacts-partial">{{ 'artifacts.partial.title' | transloco }}</h3>
              @for (reason of snapshot.partial; track reason) {
                <p>{{ 'artifacts.partial.' + reason | transloco }}</p>
              }
              <p>{{ 'artifacts.partial.hint' | transloco }}</p>
            </section>
          }
          @if (snapshot.items.length === 0) {
            <tc-state-block
              kind="empty"
              data-testid="artifacts-empty"
              [title]="'artifacts.empty.title' | transloco"
              [description]="'artifacts.empty.hint' | transloco"
            />
          } @else {
            <tc-artifact-search
              [items]="snapshot.items"
              [type]="type()"
              [query]="query()"
              [shown]="visible().length"
              (typeChange)="setFilter($event, query())"
              (queryChange)="setFilter(type(), $event)"
            />
            @if (visible().length === 0) {
              <tc-state-block
                kind="empty"
                data-testid="artifacts-no-match"
                [title]="'artifacts.noMatch.title' | transloco"
                [description]="'artifacts.noMatch.hint' | transloco"
              >
                <button tc-button tc-state-action type="button" (click)="setFilter(null, '')">
                  {{ 'artifacts.noMatch.clear' | transloco }}
                </button>
              </tc-state-block>
            } @else {
              <tc-artifact-list
                [items]="visible()"
                [label]="'artifacts.listLabel' | transloco"
                [designLeading]="designLeading"
                [designSubtitle]="designSubtitle"
                (openDesign)="openDesign($event)"
              />
              <!-- #277: the design rows' thumbnail and summary; the viewer opens from the row. -->
              <ng-template #designLeading let-design>
                @if (slug(); as slug) {
                  <tc-design-preview [slug]="slug" [issue]="design.number" />
                }
              </ng-template>
              <ng-template #designSubtitle let-design>
                @if (slug(); as slug) {
                  <tc-design-summary [slug]="slug" [issue]="design.number" />
                }
              </ng-template>
            }
          }
        }
      }
      @default {
        <tc-state-block
          kind="loading"
          data-testid="artifacts-loading"
          [title]="'artifacts.loading' | transloco"
        />
      }
    }
  `,
  styleUrl: './artifacts-section.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-artifacts' },
})
export class ArtifactsSectionPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly store = inject(ArtifactsStore);
  private readonly persisted = inject(PersistedStateStore);
  private readonly transloco = inject(TranslocoService);
  private readonly viewer = inject(DesignViewer);
  private readonly manifests = inject(DesignManifests);

  protected readonly slug = toSignal(
    (this.route.parent ?? this.route).paramMap.pipe(map((params) => params.get('slug'))),
    { initialValue: null },
  );
  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected readonly type = signal<ArtifactType | null>(null);
  protected readonly query = signal('');

  protected readonly state = computed(() => {
    const state = this.store.state();
    // Another project's list (or failure) never shows under this one while it loads.
    return state.kind !== 'idle' && state.slug === this.slug() ? state : ({ kind: 'loading' } as const);
  });
  protected readonly snapshot = computed(() => {
    const state = this.state();
    return state.kind === 'ready' ? state.snapshot : null;
  });
  protected readonly refreshing = computed(() => {
    const state = this.state();
    return state.kind === 'ready' && state.refreshing;
  });
  protected readonly failure = computed(() => {
    const state = this.state();
    return state.kind === 'failed' ? state.failure : null;
  });
  protected readonly visible = computed(() =>
    filterArtifacts(this.snapshot()?.items ?? [], { type: this.type(), query: this.query() }),
  );
  protected readonly loadedTime = computed(() => {
    const snapshot = this.snapshot();
    return snapshot === null ? '' : localTimeOf(snapshot.loadedAt, this.lang());
  });

  constructor() {
    effect(() => {
      const slug = this.slug();
      if (slug === null) {
        return;
      }
      untracked(() => {
        this.restoreFilter(slug);
        void this.store.load(slug);
      });
    });
  }

  protected reload(): void {
    const slug = this.slug();
    if (slug !== null) {
      void this.store.load(slug);
    }
  }

  protected checkAgain(): void {
    void this.store.checkAgain();
    // The design rows' lists too (#277): the team may have pushed to a design since they loaded.
    const slug = this.slug();
    if (slug !== null) {
      void this.manifests.reloadAll(slug);
    }
  }

  /** A design row (#277): the viewer over this page; focus comes back to the row when it closes. */
  protected openDesign(design: Artifact & { readonly number: number }): void {
    const slug = this.slug();
    if (slug !== null) {
      this.viewer.open({ slug, issue: design.number, title: design.title });
    }
  }

  protected setFilter(type: ArtifactType | null, query: string): void {
    const q = query.slice(0, ARTIFACT_QUERY_MAX_LENGTH);
    this.type.set(type);
    this.query.set(q);
    const slug = this.slug();
    if (slug !== null) {
      this.persisted.setArtifactFilter(slug, type === null ? { q } : { type, q });
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { type: type ?? null, q: q === '' ? null : q },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** The URL wins (a shared or reloaded link); without one, the filter this device last used for the project. */
  private restoreFilter(slug: string): void {
    const params = this.route.snapshot.queryParamMap;
    const hasUrlFilter = params.has('type') || params.has('q');
    const saved = this.persisted.projectState(slug)?.artifactFilter;
    const type = hasUrlFilter ? params.get('type') : (saved?.type ?? null);
    const query = hasUrlFilter ? (params.get('q') ?? '') : (saved?.q ?? '');
    this.type.set(isArtifactType(type) ? type : null);
    this.query.set(query.slice(0, ARTIFACT_QUERY_MAX_LENGTH));
    if (!hasUrlFilter && (this.type() !== null || this.query() !== '')) {
      this.setFilter(this.type(), this.query());
    }
  }
}
