import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Callout, Choice, DialogRef, Icon, SheetFooter } from '@console/shared/ui';

let nextSubscriptionId = 0;

/**
 * The explicit confirmation before the team moves to a Claude subscription (#688, threat model T7): the risk warning,
 * that the cost levers switch off, and a required "I understand" tick. Choose without the tick says why and focuses
 * it. Closes with `true` only when confirmed.
 */
@Component({
  selector: 'tc-subscription-sheet',
  imports: [Button, Callout, Choice, Icon, SheetFooter, TranslocoPipe],
  template: `
    <form class="subscription" novalidate [id]="id" (submit)="submit($event)">
      <p tc-callout tone="warning" class="subscription__risk" [id]="id + '-risk'">
        {{ 'teamConfig.access.risk' | transloco }}
      </p>
      <p class="subscription__levers">{{ 'teamConfig.access.levers' | transloco }}</p>
      <label tc-choice>
        <input
          type="checkbox"
          data-testid="subscription-understand"
          [checked]="understood()"
          [attr.aria-invalid]="missing() ? 'true' : null"
          [attr.aria-describedby]="missing() ? id + '-missing' : null"
          (change)="onTick($event)"
        />
        {{ 'teamConfig.access.understand' | transloco }}
      </label>
      @if (missing()) {
        <p class="subscription__missing" role="alert" [id]="id + '-missing'">
          <tc-icon name="alert" size="sm" /><span>{{
            'teamConfig.access.understandMissing' | transloco
          }}</span>
        </p>
      }
    </form>
    <ng-template tcSheetFooter="primary">
      <button tc-button type="submit" variant="primary" data-testid="subscription-ok" [attr.form]="id">
        {{ 'teamConfig.access.confirm' | transloco }}
      </button>
    </ng-template>
    <ng-template tcSheetFooter="secondary">
      <button tc-button type="button" (click)="ref.close(false)">
        {{ 'teamConfig.common.cancel' | transloco }}
      </button>
    </ng-template>
  `,
  styles: `
    .subscription {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }

    .subscription__risk,
    .subscription__levers,
    .subscription__missing {
      margin: 0;
    }

    .subscription__missing {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      color: var(--danger-text);
      font-size: var(--fs-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SubscriptionSheet {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);

  protected readonly id = `tc-subscription-${nextSubscriptionId++}`;
  protected readonly understood = signal(false);
  protected readonly missing = signal(false);

  protected onTick(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      this.understood.set(target.checked);
      this.missing.set(false);
    }
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.understood()) {
      this.ref.close(true);
      return;
    }
    this.missing.set(true);
    (event.target as HTMLFormElement | null)
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
      ?.focus();
  }
}
