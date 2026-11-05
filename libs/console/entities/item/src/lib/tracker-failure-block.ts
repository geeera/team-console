import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Icon } from '@console/shared/ui';
import { isRetryable, type TrackerFailure } from './tracker-failure';

/** The copy of each failure (`item.err.*`); `in-flight` and `unknown` read as a dropped connection. */
const COPY: Readonly<Record<TrackerFailure['kind'], string>> = {
  conflict: 'changed',
  gone: 'gone',
  invalid: 'invalid',
  forbidden: 'forbidden',
  network: 'network',
  timeout: 'timeout',
  'in-flight': 'network',
  'not-found': 'notFound',
  'session-expired': 'network',
  unknown: 'network',
};

/**
 * A tracker write that failed (#409 §2.1), as a block at the top of the screen: `role="alert"`, clay for a failure,
 * ochre for "it changed". It takes focus on arrival — its primary action when it has one (Try again, Refresh the
 * task), else the block itself (`tabindex="-1"`). Try again repeats the same request with the same idempotency key.
 */
@Component({
  selector: 'tc-tracker-failure',
  imports: [Button, Icon, TranslocoPipe],
  template: `
    <h2 class="tc-tracker-failure__title">
      <tc-icon name="alert" size="sm" />
      <span>{{ 'item.err.' + copy() + '.title' | transloco }}</span>
    </h2>
    <p class="tc-tracker-failure__message">{{ 'item.err.' + copy() + '.message' | transloco }}</p>
    @if (canRetry()) {
      <div class="tc-tracker-failure__actions">
        <button tc-button type="button" data-testid="tracker-retry" (click)="retry.emit()">
          <tc-icon name="refresh" size="sm" />
          {{ 'item.err.retry' | transloco }}
        </button>
      </div>
    } @else if (canRefresh()) {
      <div class="tc-tracker-failure__actions">
        <button tc-button type="button" data-testid="tracker-refresh" (click)="refresh.emit()">
          <tc-icon name="refresh" size="sm" />
          {{ 'item.err.gone.refresh' | transloco }}
        </button>
      </div>
    }
  `,
  styleUrl: './tracker-failure-block.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-tracker-failure',
    role: 'alert',
    tabindex: '-1',
    'data-testid': 'tracker-failure',
    '[attr.data-kind]': 'failure().kind',
    '[class.tc-tracker-failure--warn]': 'isWarning()',
  },
})
export class TrackerFailureBlock {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly failure = input.required<TrackerFailure>();
  readonly retry = output<void>();
  readonly refresh = output<void>();

  protected readonly copy = computed(() => COPY[this.failure().kind]);
  protected readonly canRetry = computed(() => isRetryable(this.failure()));
  protected readonly canRefresh = computed(() =>
    ['conflict', 'gone', 'not-found', 'invalid'].includes(this.failure().kind),
  );
  protected readonly isWarning = computed(() => ['conflict', 'gone'].includes(this.failure().kind));

  constructor() {
    afterNextRender(
      () => {
        const root = this.host.nativeElement;
        (root.querySelector<HTMLElement>('.tc-tracker-failure__actions button') ?? root).focus();
      },
      { injector: inject(Injector) },
    );
  }
}
