import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { pushTargetOf } from '@console/entities/push';
import { TranslocoPipe } from '@console/shared/i18n';
import { type Arrival, Button, markArrival, StateBlock } from '@console/shared/ui';
import { map } from 'rxjs';

export type NotFoundReason = 'project' | 'route';

/**
 * The shared error block for an unknown or archived project slug (`data.reason: 'project'`) and for
 * any other unknown URL (`'route'`), always with a way back. The URL stays as typed — no redirect.
 * A tapped notification of an archived project (`/p/{slug}/questions#n`, #36) lands here too: then the block is
 * ringed and focused, says its notifications lead here, and goes back to Needs you.
 */
@Component({
  selector: 'tc-project-not-found-page',
  imports: [Button, RouterLink, StateBlock, TranslocoPipe],
  template: `
    <h1 class="tc-sr-only">{{ titleKey() | transloco }}</h1>
    <tc-state-block
      #block
      kind="error"
      [attr.tabindex]="isPushArrival() ? -1 : null"
      [title]="titleKey() | transloco"
      [description]="hintKey() | transloco: { slug: slug() ?? '' }"
    >
      <a
        tc-button
        tc-state-action
        variant="primary"
        [routerLink]="isPushArrival() ? '/needs-you' : '/'"
        data-testid="not-found-back"
      >
        {{ (isPushArrival() ? 'push.arrive.back' : 'notFound.back') | transloco }}
      </a>
    </tc-state-block>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectNotFoundPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly block = viewChild.required('block', { read: ElementRef<HTMLElement> });

  /** Present for the `p/:slug` variant, absent for the wildcard. */
  readonly slug = input<string>();

  private readonly reason = toSignal(
    this.route.data.pipe(map((data): NotFoundReason => (data['reason'] === 'project' ? 'project' : 'route'))),
    { initialValue: 'route' as NotFoundReason },
  );

  /** Only the exact shape the Worker builds counts, checked by the same rule the tap navigation uses. */
  protected readonly isPushArrival = computed(
    () => this.reason() === 'project' && pushTargetOf(this.router.url)?.kind === 'question',
  );

  protected readonly titleKey = computed(() =>
    this.reason() === 'project' ? 'notFound.projectTitle' : 'notFound.routeTitle',
  );
  protected readonly hintKey = computed(() => {
    if (this.isPushArrival()) {
      return 'push.arrive.projectHint';
    }
    return this.reason() === 'project' ? 'notFound.projectHint' : 'notFound.routeHint';
  });

  constructor() {
    let ring: Arrival | null = null;
    afterNextRender(() => {
      if (this.isPushArrival()) {
        ring = markArrival(this.block().nativeElement);
      }
    });
    inject(DestroyRef).onDestroy(() => ring?.clear());
  }
}
