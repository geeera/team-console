import { ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, DIALOG_DATA, DialogRef, Field, FieldControl, SheetFooter } from '@console/shared/ui';
import { TEAM_CONFIG_BOUNDS, type TeamRoleSettings } from '@shared/contracts';
import { boundedIntegerOf } from '../team-fields';

export type RoleLimits = Pick<TeamRoleSettings, 'max_minutes' | 'max_turns' | 'max_parallel'>;

const LIMITS = [
  { key: 'max_minutes', label: 'teamConfig.limits.minutes', bound: TEAM_CONFIG_BOUNDS.maxMinutes },
  { key: 'max_turns', label: 'teamConfig.limits.turns', bound: TEAM_CONFIG_BOUNDS.maxTurns },
  { key: 'max_parallel', label: 'teamConfig.limits.parallel', bound: TEAM_CONFIG_BOUNDS.maxParallel },
] as const;

let nextLimitsId = 0;

/**
 * A role's per-job limits (#688, ADR 0009 d.6): minutes, turns and parallel jobs, each a whole number inside the
 * schema's bound with the range said under the field. Done with a value out of range marks the field and focuses
 * it; the draft changes only once all three are valid.
 */
@Component({
  selector: 'tc-role-limits-sheet',
  imports: [Button, Field, FieldControl, SheetFooter, TranslocoPipe],
  template: `
    <form class="limits" novalidate [id]="id" (submit)="done($event)">
      @for (limit of limits; track limit.key) {
        <tc-field
          [label]="limit.label | transloco"
          [hint]="'teamConfig.limits.range' | transloco: { min: limit.bound.min, max: limit.bound.max }"
          [error]="
            invalid().includes(limit.key)
              ? ('teamConfig.limits.range' | transloco: { min: limit.bound.min, max: limit.bound.max })
              : ''
          "
        >
          <input
            tcInput
            type="text"
            inputmode="numeric"
            autocomplete="off"
            [attr.data-testid]="'limit-' + limit.key"
            [value]="values()[limit.key]"
            (input)="onInput(limit.key, $event)"
          />
        </tc-field>
      }
    </form>
    <ng-template tcSheetFooter="primary">
      <button tc-button type="submit" variant="primary" data-testid="limits-done" [attr.form]="id">
        {{ 'teamConfig.common.done' | transloco }}
      </button>
    </ng-template>
    <ng-template tcSheetFooter="secondary">
      <button tc-button type="button" (click)="ref.close()">
        {{ 'teamConfig.common.cancel' | transloco }}
      </button>
    </ng-template>
  `,
  styles: `
    .limits {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoleLimitsSheet {
  private readonly data = inject<RoleLimits>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<RoleLimits>>(DialogRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly id = `tc-role-limits-${nextLimitsId++}`;
  protected readonly limits = LIMITS;
  protected readonly values = signal<Record<keyof RoleLimits, string>>({
    max_minutes: String(this.data.max_minutes),
    max_turns: String(this.data.max_turns),
    max_parallel: String(this.data.max_parallel),
  });
  protected readonly invalid = signal<readonly (keyof RoleLimits)[]>([]);

  protected onInput(key: keyof RoleLimits, event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      this.values.update((values) => ({ ...values, [key]: target.value }));
      this.invalid.update((keys) => keys.filter((invalid) => invalid !== key));
    }
  }

  protected done(event: Event): void {
    event.preventDefault();
    const parsed = LIMITS.map(
      (limit) =>
        [limit.key, boundedIntegerOf(this.values()[limit.key], limit.bound.min, limit.bound.max)] as const,
    );
    const invalid = parsed.filter(([, value]) => value === null).map(([key]) => key);
    this.invalid.set(invalid);
    const first = invalid[0];
    if (first !== undefined) {
      this.host.nativeElement.querySelector<HTMLElement>(`[data-testid="limit-${first}"]`)?.focus();
      return;
    }
    this.ref.close(Object.fromEntries(parsed) as unknown as RoleLimits);
  }
}
