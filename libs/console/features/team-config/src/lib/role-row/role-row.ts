import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Chip, Icon, PickerButton, Switch } from '@console/shared/ui';
import type { TeamRole, TeamRoleSettings } from '@shared/contracts';
import { controlIdOf } from '../team-fields';
import { hasNoSwitch, isNeverOff } from '../team-draft';
import { modelKeyOf } from '../team-words';

/**
 * One role of the Roles ledger (#688, UX spec §3): name, switch, model button ("Opus 5.5 · high"), limits button
 * ("90 min · 400 turns · 5 at once") and, when the role differs from its preset, the word chip "Override" with its
 * own Reset. The five never-off roles carry a locked switch, focusable, with the reason under the name and linked by
 * `aria-describedby`; `security` has no switch, only its reason. Read-only (a member) shows the values as text.
 */
@Component({
  selector: 'tc-role-row',
  imports: [Button, Chip, FormsModule, Icon, PickerButton, Switch, TranslocoPipe],
  templateUrl: './role-row.html',
  styleUrl: './role-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'role-row',
    role: 'listitem',
    '[class.role-row--off]': '!settings().enabled',
    '[attr.data-testid]': '"role-" + teamRole()',
  },
})
export class RoleRow {
  readonly teamRole = input.required<TeamRole>();
  readonly settings = input.required<TeamRoleSettings>();
  readonly isOverridden = input(false);
  readonly readOnly = input(false);
  /** The inline error of this row's model or limits, already worded. */
  readonly modelError = input<string | null>(null);
  readonly limitsError = input<string | null>(null);

  readonly toggled = output<boolean>();
  readonly pickModel = output<void>();
  readonly editLimits = output<void>();
  readonly resetRole = output<void>();

  protected readonly nameId = computed(() => `${controlIdOf(`roles.${this.teamRole()}`)}-name`);
  protected readonly reasonId = computed(() => `${controlIdOf(`roles.${this.teamRole()}`)}-reason`);
  protected readonly switchId = computed(() => controlIdOf(`roles.${this.teamRole()}.enabled`));
  protected readonly modelId = computed(() => controlIdOf(`roles.${this.teamRole()}.model`));
  protected readonly limitsId = computed(() => controlIdOf(`roles.${this.teamRole()}.limits`));
  protected readonly isLocked = computed(() => isNeverOff(this.teamRole()));
  protected readonly hasSwitch = computed(() => !hasNoSwitch(this.teamRole()));
  protected readonly modelKey = computed(() => modelKeyOf(this.settings().model));
  /** The line under the name: why the switch is locked, why there is none, or what "off" means. */
  protected readonly reasonKey = computed((): string | null => {
    if (!this.hasSwitch()) {
      return 'teamConfig.role.security';
    }
    if (this.isLocked()) {
      return 'teamConfig.role.locked';
    }
    return this.settings().enabled ? null : 'teamConfig.role.off';
  });
  protected readonly modelDescribedBy = computed(() =>
    this.modelError() === null ? null : `${this.modelId()}-error`,
  );
  protected readonly limitsDescribedBy = computed(() =>
    this.limitsError() === null ? null : `${this.limitsId()}-error`,
  );
}
