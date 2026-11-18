import { ChangeDetectionStrategy, Component, computed, ElementRef, input, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Icon } from '@console/shared/ui';

/**
 * Which «no runner» copy a viewer gets (#775): `member` the generic line with no action; `owner` the generic owner
 * copy with the Runners link; `d3` another owner's subscription runner that D3 keeps off this project; `d3-mine` the
 * viewer's own such runner. The D3 kinds are the owner's only (SECURITY review of #804).
 */
export type JobsNoneKind = 'member' | 'owner' | 'd3' | 'd3-mine';

let nextNoneId = 0;

/**
 * The block that takes Run now's place when no runner may serve the project (#775): it says why and the one way out,
 * as a link, since each one navigates. No button stands in for Run, so there is no dead control. Names arrive as
 * plain, already isolated text: interpolated, never markup.
 */
@Component({
  selector: 'tc-board-jobs-none',
  imports: [Button, Icon, RouterLink, TranslocoPipe],
  template: `
    <section class="jobs-none" data-testid="jobs-none" [attr.data-none]="kind()" [attr.aria-labelledby]="titleId">
      <span class="jobs-none__mark" aria-hidden="true"><tc-icon name="offline" size="sm" /></span>
      <h4 #title class="jobs-none__title" tabindex="-1" [id]="titleId">{{ titleKey() | transloco }}</h4>
      <p class="jobs-none__body" dir="auto" data-testid="jobs-none-body">
        {{ bodyKey() | transloco: { project: projectName(), runner: runnerName() } }}
      </p>
      @switch (kind()) {
        @case ('owner') {
          <a tc-button wrap class="jobs-none__action" routerLink="/settings/runners" data-testid="jobs-none-runners">
            <tc-icon name="settings" size="sm" />
            {{ 'jobs.none.open' | transloco }}
          </a>
        }
        @case ('d3') {
          <a
            tc-button
            wrap
            variant="primary"
            class="jobs-none__action"
            routerLink="/settings/runners"
            data-testid="jobs-none-connect"
          >
            <tc-icon name="plus" size="sm" />
            {{ 'jobs.none.d3Connect' | transloco }}
          </a>
        }
        @case ('d3-mine') {
          <a tc-button wrap class="jobs-none__action" routerLink="/settings/runners" data-testid="jobs-none-runner">
            <tc-icon name="settings" size="sm" />
            {{ 'jobs.none.d3MineOpen' | transloco: { runner: runnerName() } }}
          </a>
        }
      }
      @if (kind() === 'd3' || kind() === 'd3-mine') {
        <details class="jobs-none__why" data-testid="jobs-none-why">
          <summary>{{ 'jobs.none.why' | transloco }}</summary>
          <p>{{ 'jobs.none.whyBody' | transloco }}</p>
        </details>
      }
    </section>
  `,
  styles: `
    .jobs-none {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      justify-items: start;
      gap: var(--space-2);
      padding: var(--space-4);
      border: var(--border-w) dashed var(--border-strong);
      border-radius: var(--r-lg);
      background: var(--surface);
    }

    .jobs-none__mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: var(--icon-button-size);
      height: var(--icon-button-size);
      border-radius: var(--r-round);
      background: var(--bg-sunken);
      color: var(--text-2);
    }

    .jobs-none__title {
      margin: 0;
      font-family: var(--font-display);
      font-size: var(--fs-lg);
      font-weight: var(--fw-display);
      line-height: var(--lh-tight);
    }

    .jobs-none__title:focus {
      outline: none;
    }

    .jobs-none__title:focus-visible {
      outline: var(--focus-w) solid var(--focus);
      outline-offset: var(--focus-offset);
    }

    .jobs-none__body {
      margin: 0;
      max-width: var(--measure);
      color: var(--text-2);
      font-size: var(--fs-sm);
      line-height: var(--lh-body);
      overflow-wrap: anywhere;
    }

    .jobs-none__why {
      color: var(--text-2);
      font-size: var(--fs-sm);
    }

    .jobs-none__why summary {
      display: flex;
      align-items: center;
      min-height: var(--control-h-touch);
      color: var(--accent-text);
      font-weight: var(--fw-semibold);
      cursor: pointer;
    }

    .jobs-none__why p {
      margin: 0;
      max-width: var(--measure);
    }

    @media (max-width: 519.98px) {
      .jobs-none__action {
        width: 100%;
        justify-content: center;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardJobsNone {
  readonly kind = input.required<JobsNoneKind>();
  /** The project's name, isolated for bidi. */
  readonly projectName = input('');
  /** The D3 runner's name, isolated for bidi; the D3 kinds only. */
  readonly runnerName = input('');

  private readonly title = viewChild.required<ElementRef<HTMLElement>>('title');

  protected readonly titleId = `tc-board-jobs-none-${nextNoneId++}`;

  protected readonly titleKey = computed(() => {
    switch (this.kind()) {
      case 'd3':
        return 'jobs.none.d3Title';
      case 'd3-mine':
        return 'jobs.none.d3MineTitle';
      default:
        return 'jobs.none.title';
    }
  });

  protected readonly bodyKey = computed(() => {
    switch (this.kind()) {
      case 'member':
        return 'jobs.none.member';
      case 'owner':
        return 'jobs.none.owner';
      case 'd3':
        return 'jobs.none.d3';
      case 'd3-mine':
        return 'jobs.none.d3Mine';
    }
  });

  /** The header's «Run» lands on the heading when there is no form to land on. */
  focus(): void {
    this.title().nativeElement.focus();
  }
}
