import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AccessSession } from '@console/shared/api';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, StateBlock } from '@console/shared/ui';

/**
 * What the app shows instead of its screens once Cloudflare Access wants a new login (#284): every API call would
 * fail, so the screens' own "something went wrong" states would only mislead. One button, a full-page sign-in.
 */
@Component({
  selector: 'tc-session-expired',
  imports: [Button, StateBlock, TranslocoPipe],
  template: `
    <main class="tc-session-expired" data-testid="session-expired">
      <h1 class="tc-sr-only">{{ 'app.session.expiredTitle' | transloco }}</h1>
      <tc-state-block
        kind="error"
        [title]="'app.session.expiredTitle' | transloco"
        [description]="'app.session.expiredHint' | transloco"
      >
        <button
          tc-button
          tc-state-action
          type="button"
          variant="primary"
          data-testid="session-sign-in"
          (click)="session.signIn()"
        >
          {{ 'app.session.signIn' | transloco }}
        </button>
      </tc-state-block>
    </main>
  `,
  styles: `
    .tc-session-expired {
      display: grid;
      place-items: center;
      min-height: 100dvh;
      padding: var(--space-4);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionExpired {
  protected readonly session = inject(AccessSession);
}
