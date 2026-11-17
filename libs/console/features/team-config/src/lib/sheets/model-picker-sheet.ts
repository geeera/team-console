import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Choice, ChoiceGroup, DIALOG_DATA, DialogRef, SheetFooter } from '@console/shared/ui';
import {
  MODEL_ALLOW_LIST,
  TEAM_EFFORTS,
  allowedModelsOf,
  effortOfModel,
  type TeamConfigPreset,
  type TeamEffort,
  type TeamModel,
  type TeamRole,
} from '@shared/contracts';
import { modelKeyOf } from '../team-words';

export interface ModelPickerData {
  readonly role: TeamRole;
  readonly model: TeamModel;
  readonly effort: TeamEffort;
  readonly preset: TeamConfigPreset;
  /** The preset's model for this role, marked "In Recommended". */
  readonly presetModel: TeamModel;
}

export interface ModelPick {
  readonly model: TeamModel;
  readonly effort: TeamEffort;
}

let nextPickerId = 0;

/**
 * The model picker of a role (#688, UX spec §3): only the models allowed for the role (`allowedModelsOf`), each with
 * its one-line hint and pinned id, the preset's choice marked, the effort below. The excluded models are named in the
 * footer ("Not available for this role: Haiku 4.5") rather than hidden without a word. Effort follows the model
 * until the owner picks one here. Closes with the pick, or nothing on Cancel; the draft changes only on Done.
 */
@Component({
  selector: 'tc-model-picker-sheet',
  imports: [Button, Choice, ChoiceGroup, SheetFooter, TranslocoPipe],
  template: `
    <form class="picker" novalidate [id]="id" (submit)="done($event)">
      <fieldset tc-choice-group [legend]="'teamConfig.picker.model' | transloco">
        @for (model of allowed; track model) {
          <label tc-choice>
            <input
              type="radio"
              [name]="id + '-model'"
              [value]="model"
              [checked]="model === picked()"
              [attr.data-testid]="'model-' + model"
              [attr.aria-describedby]="id + '-' + keyOf(model)"
              (change)="pickModel(model)"
            />
            {{ 'teamConfig.model.' + keyOf(model) | transloco }}
            @if (model === data.presetModel) {
              <span class="picker__in-preset">
                · {{ 'teamConfig.picker.inPreset' | transloco: { preset: ('teamConfig.preset.' + data.preset | transloco) } }}
              </span>
            }
            <small tc-choice-hint [id]="id + '-' + keyOf(model)">
              {{ 'teamConfig.model.hint.' + keyOf(model) | transloco }} <code class="picker__id">{{ model }}</code>
            </small>
          </label>
        }
      </fieldset>
      <fieldset tc-choice-group [legend]="'teamConfig.picker.effort' | transloco">
        @for (effort of efforts; track effort) {
          <label tc-choice>
            <input
              type="radio"
              [name]="id + '-effort'"
              [value]="effort"
              [checked]="effort === effortPicked()"
              [attr.data-testid]="'effort-' + effort"
              [attr.aria-describedby]="id + '-effort-hint'"
              (change)="pickEffort(effort)"
            />
            {{ 'teamConfig.effort.' + effort | transloco }}
          </label>
        }
      </fieldset>
      <p class="picker__hint" [id]="id + '-effort-hint'">{{ 'teamConfig.picker.effortHint' | transloco }}</p>
      @if (excluded.length > 0) {
        <p class="picker__excluded" data-testid="model-not-allowed">
          {{ 'teamConfig.picker.notAllowed' | transloco: { models: excludedNames() } }}
        </p>
      }
    </form>
    <ng-template tcSheetFooter="primary">
      <button tc-button type="submit" variant="primary" data-testid="model-done" [attr.form]="id">
        {{ 'teamConfig.common.done' | transloco }}
      </button>
    </ng-template>
    <ng-template tcSheetFooter="secondary">
      <button tc-button type="button" (click)="ref.close()">{{ 'teamConfig.common.cancel' | transloco }}</button>
    </ng-template>
  `,
  styles: `
    .picker {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }

    .picker__in-preset,
    .picker__hint,
    .picker__excluded {
      color: var(--text-2);
      font-size: var(--fs-sm);
    }

    .picker__hint,
    .picker__excluded {
      margin: 0;
    }

    .picker__id {
      font-family: var(--font-mono);
      font-size: var(--fs-xs);
      overflow-wrap: anywhere;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelPickerSheet {
  protected readonly data = inject<ModelPickerData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<ModelPick>>(DialogRef);
  private readonly transloco = inject(TranslocoService);

  protected readonly id = `tc-model-picker-${nextPickerId++}`;
  protected readonly allowed = allowedModelsOf(this.data.role);
  protected readonly excluded = MODEL_ALLOW_LIST.filter((model) => !this.allowed.includes(model));
  protected readonly efforts = TEAM_EFFORTS;
  protected readonly picked = signal<TeamModel>(this.data.model);
  protected readonly effortPicked = signal<TeamEffort>(this.data.effort);
  private readonly hasPickedEffort = signal(false);

  protected readonly keyOf = modelKeyOf;
  protected readonly excludedNames = computed(() => this.excluded.map((model) => this.nameOf(model)).join(', '));

  protected pickModel(model: TeamModel): void {
    this.picked.set(model);
    if (!this.hasPickedEffort()) {
      this.effortPicked.set(effortOfModel(model));
    }
  }

  protected pickEffort(effort: TeamEffort): void {
    this.effortPicked.set(effort);
    this.hasPickedEffort.set(true);
  }

  protected done(event: Event): void {
    event.preventDefault();
    this.ref.close({ model: this.picked(), effort: this.effortPicked() });
  }

  private nameOf(model: TeamModel): string {
    return this.transloco.translate(`teamConfig.model.${modelKeyOf(model)}`);
  }
}
