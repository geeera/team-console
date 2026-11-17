import { booleanAttribute, ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Choice, ChoiceGroup } from '@console/shared/ui';
import type { RunnerProjectScope } from '@shared/contracts';
import { RunnerProjectsPicker, type RunnerProjectOption } from './runner-projects-picker';

let nextPickerId = 0;

/**
 * Which projects a runner serves (#775, `runners.project_scope`): every project of the account, present and future
 * (`all`, the default for a new runner), or only the ticked ones (`selected`, the projects picker below the radio).
 * Used by enrolment and by the scope editor. The hint under `all` says plainly what it covers, including owner decision
 * D3 for an account with several owners. `allowedProjects` stays as the owner left it when they switch to `all`, so
 * switching back restores the list; the Worker stores `[]` under `all`.
 */
@Component({
  selector: 'tc-runner-scope-picker',
  imports: [Choice, ChoiceGroup, RunnerProjectsPicker, TranslocoPipe],
  template: `
    <div class="runner-scope">
      <fieldset tc-choice-group [legend]="legend()">
        <label tc-choice>
          <input
            type="radio"
            value="all"
            data-testid="runner-scope-all"
            [name]="groupName"
            [checked]="scope() === 'all'"
            [disabled]="disabled()"
            [attr.aria-describedby]="groupName + '-all-hint'"
            (change)="scope.set('all')"
          />
          {{ 'runners.scope.all' | transloco }}
          <small tc-choice-hint [id]="groupName + '-all-hint'">{{ 'runners.scope.allHint' | transloco }}</small>
        </label>
        <label tc-choice>
          <input
            type="radio"
            value="selected"
            data-testid="runner-scope-selected"
            [name]="groupName"
            [checked]="scope() === 'selected'"
            [disabled]="disabled()"
            [attr.aria-describedby]="groupName + '-selected-hint'"
            (change)="scope.set('selected')"
          />
          {{ 'runners.scope.selected' | transloco }}
          <small tc-choice-hint [id]="groupName + '-selected-hint'">{{ 'runners.scope.selectedHint' | transloco }}</small>
        </label>
      </fieldset>
      @if (scope() === 'selected') {
        <tc-runner-projects-picker
          [legend]="projectsLegend()"
          [projects]="projects()"
          [disabled]="disabled()"
          [(selected)]="selected"
        />
      }
    </div>
  `,
  styles: `
    .runner-scope {
      display: grid;
      gap: var(--space-4);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunnerScopePicker {
  /** Already translated. */
  readonly legend = input.required<string>();
  /** The projects picker's legend under `selected`; already translated. */
  readonly projectsLegend = input.required<string>();
  readonly projects = input.required<readonly RunnerProjectOption[]>();
  readonly scope = model<RunnerProjectScope>('all');
  readonly selected = model<readonly string[]>([]);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly groupName = `tc-runner-scope-${nextPickerId++}`;
}
