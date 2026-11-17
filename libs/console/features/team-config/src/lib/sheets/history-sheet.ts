import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { localDayOf, localTimeOf, TranslocoPipe, TranslocoPluralPipe, TranslocoService } from '@console/shared/i18n';
import {
  Button,
  DIALOG_DATA,
  DialogRef,
  Icon,
  List,
  ListRow,
  StateBlock,
} from '@console/shared/ui';
import type { TeamConfigRevisionDto, TeamConfigRevisionSummaryDto } from '@shared/contracts';
import { ChangesTable } from '../changes-table/changes-table';
import { TeamConfigClient } from '../team-config.client';
import { rawDiffOf, revisionChangesOf } from '../team-words';

export interface HistorySheetData {
  readonly slug: string;
  /** The owner may take a revision as the draft; a member only reads (UX spec §4 "Read-only"). */
  readonly canUseDraft: boolean;
  /** The revision the page shows: the history reads the newest window up from it. */
  readonly latestRevision: number;
}

type Phase = 'loading' | 'ready' | 'failed';

/** Rows shown before "Show N more": a phone screen and a bit. */
export const HISTORY_SHOWN_STEP = 20;

let nextHistoryId = 0;

/**
 * Settings › Team › History (#688, UX spec §2.8): every revision newest first with its number, author, time, how many
 * settings it changed and its reason; a row opens the revision as a diff in words with the raw JSON behind "Show
 * raw". Read-only: there is no restore. "Use as draft" closes with the revision, and the page puts it in the form
 * for an ordinary review and save, so the history stays an honest record. A list that fails to load is this
 * sheet's own error with Try again (UX spec §4 "Partial"): the form behind it is current and untouched.
 *
 * The reason and the author are the owner's own text and are only ever interpolated, never HTML (threat model T4).
 */
@Component({
  selector: 'tc-history-sheet',
  imports: [Button, ChangesTable, Icon, List, ListRow, StateBlock, TranslocoPipe, TranslocoPluralPipe],
  template: `
    <div class="history">
      @if (open(); as opened) {
        <button tc-button variant="quiet" type="button" class="history__back" data-testid="history-back" (click)="back()">
          <tc-icon name="chevron-left" size="sm" />{{ 'teamConfig.history.back' | transloco }}
        </button>
        @switch (revisionPhase()) {
          @case ('loading') {
            <tc-state-block kind="loading" compact [title]="'teamConfig.history.revisionLoading' | transloco: { n: opened }" />
          }
          @case ('failed') {
            <tc-state-block
              kind="error"
              compact
              data-testid="revision-error"
              [title]="'teamConfig.history.revisionFailed' | transloco: { n: opened }"
            >
              <button tc-button tc-state-action size="sm" type="button" data-testid="revision-retry" (click)="openRevision(opened)">
                {{ 'teamConfig.common.retry' | transloco }}
              </button>
            </tc-state-block>
          }
          @case ('ready') {
            @if (revision(); as revision) {
              <section class="history__revision" data-testid="revision" [attr.aria-labelledby]="id + '-revision'">
                <div class="history__revision-head">
                  <div>
                    <h3 #revisionHeading class="history__revision-title" tabindex="-1" [id]="id + '-revision'">
                      {{ 'teamConfig.history.revision' | transloco: { n: revision.revision } }}
                    </h3>
                    <p class="history__meta" data-testid="revision-meta">
                      {{ authorOf(revision.createdByName) }} · {{ whenOf(revision.createdAt) }}
                    </p>
                  </div>
                  @if (data.canUseDraft) {
                    <button tc-button type="button" data-testid="revision-use" (click)="useAsDraft(revision)">
                      {{ 'teamConfig.history.useAsDraft' | transloco }}
                    </button>
                  }
                </div>
                @if (revision.reason; as reason) {
                  <blockquote class="history__reason" data-testid="revision-reason">{{ reason }}</blockquote>
                } @else {
                  <p class="history__meta" data-testid="revision-reason">{{ 'teamConfig.history.noReason' | transloco }}</p>
                }
                @if (rows().length > 0) {
                  <tc-changes-table [rows]="rows()" [caption]="'teamConfig.history.revision' | transloco: { n: revision.revision }" />
                } @else {
                  <p class="history__meta">{{ 'teamConfig.history.noSettings' | transloco }}</p>
                }
                <button
                  tc-button
                  variant="quiet"
                  type="button"
                  class="history__raw-toggle"
                  data-testid="revision-raw-toggle"
                  [attr.aria-expanded]="showRaw() ? 'true' : 'false'"
                  [attr.aria-controls]="id + '-raw'"
                  (click)="showRaw.set(!showRaw())"
                >
                  {{ (showRaw() ? 'teamConfig.history.hideRaw' : 'teamConfig.history.showRaw') | transloco }}
                </button>
                <pre class="history__raw" data-testid="revision-raw" [id]="id + '-raw'" [hidden]="!showRaw()">{{ raw() }}</pre>
              </section>
            }
          }
        }
      } @else {
        <p class="history__lead">{{ 'teamConfig.history.lead' | transloco }}</p>
        @switch (listPhase()) {
          @case ('loading') {
            <tc-state-block kind="loading" compact [title]="'teamConfig.history.loading' | transloco" />
          }
          @case ('failed') {
            <tc-state-block
              kind="error"
              data-testid="history-error"
              [title]="'teamConfig.history.failedTitle' | transloco"
              [description]="'teamConfig.history.failed' | transloco"
            >
              <button tc-button tc-state-action type="button" data-testid="history-retry" (click)="loadHistory()">
                <tc-icon name="refresh" size="sm" />{{ 'teamConfig.common.retry' | transloco }}
              </button>
            </tc-state-block>
          }
          @case ('ready') {
            @if (revisions().length === 0) {
              <tc-state-block kind="empty" compact data-testid="history-empty" [title]="'teamConfig.history.empty' | transloco" />
            } @else {
              <tc-list data-testid="history-list" [attr.aria-label]="'teamConfig.history.title' | transloco">
                @for (summary of shown(); track summary.revision) {
                  <tc-list-row
                    button
                    [attr.data-testid]="'history-row-' + summary.revision"
                    (click)="openRevision(summary.revision)"
                  >
                    <span tc-row-leading class="history__n">{{ summary.revision }}</span>
                    <span tc-row-title>
                      <span class="history__author">{{ authorOf(summary.createdByName) }}</span>
                      <span class="history__meta">
                        {{ whenOf(summary.createdAt) }} ·
                        {{ 'teamConfig.history.settings' | translocoPlural: settingsOf(summary) }}
                      </span>
                    </span>
                    <span tc-row-detail [class.history__reason-line]="summary.reason !== null" data-testid="history-reason">
                      {{ summary.reason ?? ('teamConfig.history.noReason' | transloco) }}
                    </span>
                    <tc-icon tc-row-trailing name="chevron-right" size="sm" />
                  </tc-list-row>
                }
              </tc-list>
              @if (hidden() > 0) {
                <button tc-button type="button" class="history__more" data-testid="history-more" (click)="showMore()">
                  {{ 'teamConfig.history.more' | translocoPlural: hidden() }}
                </button>
              }
              @if (isCut()) {
                <p class="history__meta">{{ 'teamConfig.history.cut' | transloco }}</p>
              }
            }
          }
        }
      }
    </div>
  `,
  styles: `
    .history {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      padding: var(--space-4);
      overflow-y: auto;
      min-height: 0;
      flex: 1;
    }

    .history__lead,
    .history__meta,
    .history__revision-title,
    .history__reason {
      margin: 0;
    }

    .history__lead,
    .history__meta {
      color: var(--text-2);
    }

    .history__back,
    .history__more,
    .history__raw-toggle {
      align-self: flex-start;
    }

    .history__n {
      min-width: var(--space-6);
      font-family: var(--font-display);
      font-size: var(--fs-xl);
    }

    .history__author {
      margin-inline-end: var(--space-2);
      font-weight: var(--fw-semibold);
    }

    .history__reason-line,
    .history__reason {
      font-style: italic;
      overflow-wrap: anywhere;
    }

    .history__revision {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }

    .history__revision-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--space-3);
    }

    .history__revision-title {
      font-size: var(--fs-2xl);
    }

    .history__revision-title:focus {
      outline: none;
    }

    .history__revision-title:focus-visible {
      outline: var(--focus-w) solid var(--focus);
      outline-offset: var(--focus-offset);
    }

    .history__reason {
      padding-inline-start: var(--space-4);
      border-inline-start: var(--border-w-strong) solid var(--border);
      font-size: var(--fs-lg);
    }

    .history__raw {
      margin: 0;
      padding: var(--space-4);
      border-radius: var(--r-md);
      background: var(--bg-sunken);
      font-family: var(--font-mono);
      font-size: var(--fs-sm);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistorySheet {
  protected readonly data = inject<HistorySheetData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<TeamConfigRevisionDto>>(DialogRef);
  private readonly client = inject(TeamConfigClient);
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly revisionHeading = viewChild<ElementRef<HTMLElement>>('revisionHeading');
  private readonly lang = toSignal(this.transloco.langChanges$, { initialValue: this.transloco.getActiveLang() });

  protected readonly id = `tc-history-${nextHistoryId++}`;
  protected readonly listPhase = signal<Phase>('loading');
  protected readonly revisions = signal<readonly TeamConfigRevisionSummaryDto[]>([]);
  protected readonly isCut = signal(false);
  protected readonly shownCount = signal(HISTORY_SHOWN_STEP);
  protected readonly shown = computed(() => this.revisions().slice(0, this.shownCount()));
  protected readonly hidden = computed(() => Math.max(0, this.revisions().length - this.shownCount()));

  /** The revision number the sheet shows, or `null` on the list. */
  protected readonly open = signal<number | null>(null);
  protected readonly revisionPhase = signal<Phase>('loading');
  protected readonly revision = signal<TeamConfigRevisionDto | null>(null);
  protected readonly showRaw = signal(false);
  protected readonly rows = computed(() => {
    const revision = this.revision();
    return revision === null ? [] : revisionChangesOf(this.t, this.lang(), revision.diff);
  });
  protected readonly raw = computed(() => {
    const revision = this.revision();
    return revision === null ? '' : rawDiffOf(revision.diff);
  });

  constructor() {
    void this.loadHistory();
  }

  protected async loadHistory(): Promise<void> {
    this.listPhase.set('loading');
    const result = await this.client.history(this.data.slug, this.data.latestRevision);
    if (!result.ok) {
      this.listPhase.set('failed');
      return;
    }
    this.revisions.set(result.revisions);
    this.isCut.set(result.isCut);
    this.listPhase.set('ready');
  }

  protected async openRevision(n: number): Promise<void> {
    this.open.set(n);
    this.showRaw.set(false);
    this.revision.set(null);
    this.revisionPhase.set('loading');
    const result = await this.client.revision(this.data.slug, n);
    if (this.open() !== n) {
      return;
    }
    if (!result.ok) {
      this.revisionPhase.set('failed');
      return;
    }
    this.revision.set(result.revision);
    this.revisionPhase.set('ready');
    afterNextRender(() => this.revisionHeading()?.nativeElement.focus(), { injector: this.injector });
  }

  protected back(): void {
    const n = this.open();
    this.open.set(null);
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>(`[data-testid="history-row-${String(n)}"] button`)?.focus(),
      { injector: this.injector },
    );
  }

  protected showMore(): void {
    this.shownCount.update((count) => count + HISTORY_SHOWN_STEP);
  }

  protected useAsDraft(revision: TeamConfigRevisionDto): void {
    this.ref.close(revision);
  }

  protected authorOf(name: string | null): string {
    this.lang();
    return name ?? this.t('teamConfig.owner');
  }

  protected whenOf(at: string): string {
    const lang = this.lang();
    return this.t('teamConfig.history.when', { day: localDayOf(at, lang), time: localTimeOf(at, lang) });
  }

  /** Settings a revision changed, the schema tag aside. */
  protected settingsOf(summary: TeamConfigRevisionSummaryDto): number {
    return summary.paths.filter((path) => path !== 'schema').length;
  }

  private readonly t = (key: string, params?: Record<string, unknown>): string => this.transloco.translate(key, params);
}
