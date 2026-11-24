import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ActionsSetupApi, type ActionsCheckProblem } from '@console/entities/actions-setup';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, CopyCode, Icon, injectRetryFocus, StateBlock } from '@console/shared/ui';
import { isGitHubUiUrl, type ActionsWorkflowDto } from '@shared/contracts';

export const WORKFLOW_FILE_PATH = '.github/workflows/team-console-runner.yml';

/**
 * The Copy path (#759 UX spec §3.4): this console's rendering of the workflow file, from `GET …/workflow`, with its
 * version and sha256, Copy, and «Создать файл на GitHub». It never needs the app's write permissions, so it is always
 * there next to the PR button. The file is never put in a URL: the customer pastes it.
 */
@Component({
  selector: 'tc-workflow-file',
  imports: [Button, CopyCode, Icon, StateBlock, TranslocoPipe],
  template: `
    @switch (status()) {
      @case ('loading') {
        <tc-state-block kind="loading" compact [title]="'actions.file.loading' | transloco" />
      }
      @case ('error') {
        <div role="alert">
          <tc-state-block
            kind="error"
            compact
            data-testid="workflow-file-error"
            [title]="(problem()?.kind === 'misconfigured' ? 'actions.file.misconfigured' : 'actions.file.err') | transloco"
          >
            @if (problem()?.kind !== 'misconfigured') {
              <button tc-button tc-state-action size="sm" type="button" (click)="retry()">
                {{ 'settings.common.retry' | transloco }}
              </button>
            }
          </tc-state-block>
        </div>
      }
      @case ('ready') {
        @if (file(); as file) {
          <div class="file" data-testid="workflow-file">
            <p class="file__meta" data-testid="workflow-file-meta">
              {{ 'actions.file.meta' | transloco: { version: file.version, sha: file.sha256.slice(0, 12) } }}
            </p>
            <tc-copy-code
              class="file__code"
              [regionLabel]="'actions.file.region' | transloco"
              [code]="file.text"
              [ariaLabel]="'actions.file.copyAria' | transloco"
              [copyLabel]="'settings.common.copy' | transloco"
              [copiedLabel]="'settings.common.copied' | transloco"
              [failedNote]="'settings.common.copyFailed' | transloco"
            />
            @if (createUrl(); as url) {
              <a class="file__link" data-testid="workflow-file-create" [href]="url" target="_blank" rel="noopener noreferrer">
                {{ 'actions.file.create' | transloco }}<span class="tc-sr-only"> {{ 'settings.common.external' | transloco }}</span>
                <tc-icon name="external" size="sm" />
              </a>
            }
            <p class="file__note">{{ 'actions.file.protected' | transloco: { branch: branchLabel() } }}</p>
          </div>
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .file {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-2);
    }
    .file__meta,
    .file__note {
      margin: 0;
      font-size: var(--fs-sm);
      color: var(--text-2);
      overflow-wrap: anywhere;
    }
    .file__code {
      min-width: 0;
    }
    .file__link {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      min-height: var(--control-h);
      color: var(--accent-text);
      font-size: var(--fs-sm);
      font-weight: var(--fw-semibold);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowFile {
  private readonly api = inject(ActionsSetupApi);
  private readonly restoreRetryFocus = injectRetryFocus();

  readonly slug = input.required<string>();
  /** `owner/name`; the «Создать файл» link needs it and the default branch. */
  readonly repo = input.required<string>();
  readonly branch = input<string | null>(null);
  /** Shown when the branch is unknown. */
  readonly branchLabel = input.required<string>();

  protected readonly status = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly file = signal<ActionsWorkflowDto | null>(null);
  protected readonly problem = signal<ActionsCheckProblem | null>(null);

  protected readonly createUrl = computed(() => {
    const branch = this.branch();
    if (branch === null) {
      return null;
    }
    const url = `https://github.com/${this.repo()}/new/${encodeURIComponent(branch)}?filename=${WORKFLOW_FILE_PATH}`;
    return isGitHubUiUrl(url) ? url : null;
  });

  constructor() {
    effect(() => {
      const slug = this.slug();
      untracked(() => void this.load(slug));
    });
  }

  protected async retry(): Promise<void> {
    await this.load(this.slug());
    this.restoreRetryFocus();
  }

  private async load(slug: string): Promise<void> {
    this.status.set('loading');
    const result = await this.api.workflow(slug);
    if (this.slug() !== slug) {
      return;
    }
    if (result.ok) {
      this.file.set(result.value);
      this.status.set('ready');
      return;
    }
    this.problem.set(result.problem);
    this.status.set('error');
  }
}
