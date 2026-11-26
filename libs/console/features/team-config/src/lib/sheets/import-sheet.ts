import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { pluralKeyOf, TranslocoPipe, TranslocoPluralPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Callout, DIALOG_DATA, DialogRef, Icon, SheetFooter, StateBlock } from '@console/shared/ui';
import type { TeamConfigImportDto } from '@shared/contracts';
import { ChangesTable } from '../changes-table/changes-table';
import { TeamConfigClient, type TeamImportFailure } from '../team-config.client';
import { changesOf, importedSectionCountOf, withImported, type TeamDraft } from '../team-draft';
import { draftChangeRowsOf } from '../team-words';

export interface ImportSheetData {
  readonly slug: string;
  /** The form's draft now: the import goes over it, and the table shows what it would change. */
  readonly draft: TeamDraft;
}

type Phase = 'loading' | 'ready' | 'failed';

/**
 * Import from project.yml (#688, UX spec §2.7): the Worker reads the default branch's `.product-team/project.yml`
 * and answers a draft; this sheet shows what it would change in the form (Setting · Was · Now), the notes (a lossy
 * mapping such as `review.qa: never`) and the keys it did not take. "Use as draft" closes with the new draft, which the
 * page puts in the form unsaved; nothing is ever saved from here. A failed read is an error with Try again.
 *
 * Paths in the notes are keys of a repository file anyone with merge rights writes: interpolated text only (T4).
 */
@Component({
  selector: 'tc-import-sheet',
  imports: [Button, Callout, ChangesTable, Icon, SheetFooter, StateBlock, TranslocoPipe, TranslocoPluralPipe],
  template: `
    <div class="import" data-testid="import-sheet" [attr.aria-busy]="phase() === 'loading' ? 'true' : null">
      @switch (phase()) {
        @case ('loading') {
          <tc-state-block
            kind="loading"
            compact
            data-testid="import-loading"
            [title]="'teamConfig.import.loading' | transloco"
          />
        }
        @case ('failed') {
          <tc-state-block
            kind="error"
            data-testid="import-error"
            [title]="'teamConfig.import.failedTitle' | transloco"
            [description]="'teamConfig.import.failed.' + failure() | transloco"
          />
        }
        @case ('ready') {
          @if (result(); as result) {
            <p class="import__source" data-testid="import-source">
              {{ 'teamConfig.import.source' | translocoPlural: sections() : { ref: result.source.ref } }}
            </p>
            <h3 class="import__heading">{{ 'teamConfig.import.values' | transloco }}</h3>
            @if (rows().length > 0) {
              <tc-changes-table [rows]="rows()" [caption]="'teamConfig.import.values' | transloco" />
            } @else {
              <p class="import__muted" data-testid="import-same">
                {{ 'teamConfig.import.same' | transloco }}
              </p>
            }
            @if (lossy().length > 0) {
              <section
                tc-callout
                tone="warning"
                data-testid="import-notes"
                [attr.aria-labelledby]="'tc-import-notes'"
              >
                <h3 tc-callout-title id="tc-import-notes">{{ 'teamConfig.import.notes' | transloco }}</h3>
                <ul class="import__list">
                  @for (note of lossy(); track note.path) {
                    <li>{{ 'teamConfig.import.note.never-as-code' | transloco: { path: note.path } }}</li>
                  }
                </ul>
              </section>
            }
            @if (ignored().length > 0) {
              <section
                class="import__ignored"
                data-testid="import-ignored"
                aria-labelledby="tc-import-ignored"
              >
                <h3 class="import__heading" id="tc-import-ignored">
                  {{ 'teamConfig.import.ignored' | transloco }}
                </h3>
                <ul class="import__list">
                  @for (note of ignored(); track note.path) {
                    <li>
                      <code class="import__path">{{ note.path }}</code>
                      {{ 'teamConfig.import.note.' + note.code | transloco }}
                    </li>
                  }
                </ul>
              </section>
            }
            <p class="import__saves">{{ 'teamConfig.import.savesNothing' | transloco }}</p>
          }
        }
      }
    </div>
    <ng-template tcSheetFooter="primary">
      @if (phase() === 'failed') {
        <button tc-button type="button" variant="primary" data-testid="import-retry" (click)="load()">
          <tc-icon name="refresh" size="sm" />{{ 'teamConfig.common.retry' | transloco }}
        </button>
      } @else {
        <button
          tc-button
          type="button"
          variant="primary"
          data-testid="import-use"
          [attr.aria-disabled]="phase() === 'ready' ? null : 'true'"
          (click)="use()"
        >
          {{ 'teamConfig.history.useAsDraft' | transloco }}
        </button>
      }
    </ng-template>
    <ng-template tcSheetFooter="secondary">
      <button tc-button type="button" data-testid="import-cancel" (click)="cancel()">
        {{ 'teamConfig.common.cancel' | transloco }}
      </button>
    </ng-template>
  `,
  styles: `
    .import {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }

    .import__source,
    .import__heading,
    .import__muted,
    .import__saves,
    .import__list {
      margin: 0;
    }

    .import__source,
    .import__muted {
      color: var(--text-2);
    }

    .import__heading {
      font-size: var(--fs-md);
      font-weight: var(--fw-semibold);
    }

    .import__ignored {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .import__list {
      padding-inline-start: var(--space-5);
    }

    .import__path {
      font-family: var(--font-mono);
      font-size: var(--fs-sm);
      overflow-wrap: anywhere;
    }

    .import__saves {
      padding-inline-start: var(--space-3);
      border-inline-start: var(--border-w-strong) solid var(--border);
      color: var(--text-2);
      font-size: var(--fs-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImportSheet {
  private readonly data = inject<ImportSheetData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<TeamDraft>>(DialogRef);
  private readonly client = inject(TeamConfigClient);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected readonly phase = signal<Phase>('loading');
  protected readonly failure = signal<TeamImportFailure>('failed');
  protected readonly result = signal<TeamConfigImportDto | null>(null);
  protected readonly merged = computed(() => {
    const result = this.result();
    return result === null ? null : withImported(this.data.draft, result.draft);
  });
  protected readonly rows = computed(() => {
    const merged = this.merged();
    return merged === null ? [] : draftChangeRowsOf(this.t, this.lang(), changesOf(this.data.draft, merged));
  });
  protected readonly sections = computed(() => {
    const result = this.result();
    return result === null ? 0 : importedSectionCountOf(result.draft);
  });
  protected readonly lossy = computed(() =>
    (this.result()?.notes ?? []).filter((note) => note.code === 'never-as-code'),
  );
  protected readonly ignored = computed(() =>
    (this.result()?.notes ?? []).filter((note) => note.code !== 'never-as-code'),
  );

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.phase.set('loading');
    const result = await this.client.importDraft(this.data.slug);
    if (!result.ok) {
      this.failure.set(result.failure);
      this.phase.set('failed');
      void this.announcer.announce(this.t('teamConfig.import.failedTitle'), 'assertive');
      return;
    }
    this.result.set(result.draft);
    this.phase.set('ready');
    const n = importedSectionCountOf(result.draft.draft);
    void this.announcer.announce(
      this.t(pluralKeyOf('teamConfig.import.source', this.lang(), n), { ref: result.draft.source.ref, n }),
      'polite',
    );
  }

  protected use(): void {
    const merged = this.merged();
    if (this.phase() === 'ready' && merged !== null) {
      this.ref.close(merged);
    }
  }

  protected cancel(): void {
    this.ref.close();
  }

  private readonly t = (key: string, params?: Record<string, unknown>): string =>
    this.transloco.translate(key, params);
}
