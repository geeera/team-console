import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, StateBlock } from '@console/shared/ui';
import { map } from 'rxjs';

export type NotFoundReason = 'project' | 'route';

/**
 * The shared error block for an unknown or archived project slug (`data.reason: 'project'`) and for
 * any other unknown URL (`'route'`), always with a way back. The URL stays as typed — no redirect.
 */
@Component({
  selector: 'tc-project-not-found-page',
  imports: [Button, RouterLink, StateBlock, TranslocoPipe],
  template: `
    <h1 class="tc-sr-only">{{ titleKey() | transloco }}</h1>
    <tc-state-block
      kind="error"
      [title]="titleKey() | transloco"
      [description]="hintKey() | transloco: { slug: slug() ?? '' }"
    >
      <a tc-button tc-state-action variant="primary" routerLink="/" data-testid="not-found-back">
        {{ 'notFound.back' | transloco }}
      </a>
    </tc-state-block>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectNotFoundPage {
  private readonly route = inject(ActivatedRoute);

  /** Present for the `p/:slug` variant, absent for the wildcard. */
  readonly slug = input<string>();

  private readonly reason = toSignal(
    this.route.data.pipe(map((data): NotFoundReason => (data['reason'] === 'project' ? 'project' : 'route'))),
    { initialValue: 'route' as NotFoundReason },
  );

  protected readonly titleKey = computed(() =>
    this.reason() === 'project' ? 'notFound.projectTitle' : 'notFound.routeTitle',
  );
  protected readonly hintKey = computed(() =>
    this.reason() === 'project' ? 'notFound.projectHint' : 'notFound.routeHint',
  );
}
