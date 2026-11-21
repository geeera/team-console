import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { RunnerScopePicker, type RunnerProjectOption } from '@console/entities/runner';
import { TranslocoPipe } from '@console/shared/i18n';
import { Choice, ChoiceGroup, Field, FieldControl } from '@console/shared/ui';
import { RUNNER_NAME_MAX_LENGTH, type RunnerProjectScope } from '@shared/contracts';
import type { RunnerPlatform } from '../add-runner.model';

/**
 * Step 1 «Параметры» (spec §3.1): the runner's name, its scope with the D3 line, and the platform. Busy makes every
 * field read-only; the footer button submits the form by its id.
 */
@Component({
  selector: 'tc-add-runner-params-step',
  imports: [Choice, ChoiceGroup, Field, FieldControl, RunnerScopePicker, TranslocoPipe],
  template: `
    <form class="params" [id]="formId()" (submit)="submitted.emit($event)" novalidate>
      <p class="step__lead">{{ 'runners.wizard.lead' | transloco }}</p>
      <tc-field
        [label]="'runners.enrol.name' | transloco"
        [hint]="'runners.enrol.nameHint' | transloco"
        [error]="nameError() ?? ''"
        required
      >
        <input
          tcInput
          type="text"
          autocomplete="off"
          data-testid="wizard-name"
          [maxLength]="nameMaxLength"
          [readOnly]="busy()"
          [value]="name()"
          (input)="name.set($any($event.target).value)"
        />
      </tc-field>
      <tc-runner-scope-picker
        [legend]="'runners.scope.legend' | transloco"
        [projectsLegend]="'runners.projects.legend' | transloco"
        [projects]="projects()"
        [ownerCount]="ownerCount()"
        [disabled]="busy()"
        [(scope)]="scope"
        [(selected)]="selected"
      />
      @if (scope() === 'selected' && selected().length === 0 && projects().length > 0) {
        <p class="step__meta" data-testid="wizard-no-projects">{{ 'runners.enrol.noProjects' | transloco }}</p>
      }
      <fieldset tc-choice-group [legend]="'runners.wizard.platform.legend' | transloco">
        <label tc-choice>
          <input
            type="radio"
            value="mac"
            data-testid="wizard-platform-mac"
            [name]="formId() + '-platform'"
            [checked]="platform() === 'mac'"
            [disabled]="busy()"
            [attr.aria-describedby]="formId() + '-mac-hint'"
            (change)="platform.set('mac')"
          />
          {{ 'runners.wizard.platform.mac' | transloco }}
          <small tc-choice-hint [id]="formId() + '-mac-hint'">
            {{ 'runners.wizard.platform.macHint' | transloco }}
            <span class="params__quiet">{{
              'runners.wizard.platform.isolation' | transloco: { backend: ('runners.backend.user' | transloco) }
            }}</span>
          </small>
        </label>
        <label tc-choice>
          <input
            type="radio"
            value="linux"
            data-testid="wizard-platform-linux"
            [name]="formId() + '-platform'"
            [checked]="platform() === 'linux'"
            [disabled]="busy()"
            [attr.aria-describedby]="formId() + '-linux-hint'"
            (change)="platform.set('linux')"
          />
          {{ 'runners.wizard.platform.linux' | transloco }}
          <small tc-choice-hint [id]="formId() + '-linux-hint'">
            {{ 'runners.wizard.platform.linuxHint' | transloco }}
            <span class="params__quiet">{{
              'runners.wizard.platform.isolation' | transloco: { backend: ('runners.backend.container' | transloco) }
            }}</span>
          </small>
        </label>
      </fieldset>
      <p class="step__meta" data-testid="wizard-pkg-later">{{ 'runners.wizard.platform.pkgLater' | transloco }}</p>
      <ng-content />
    </form>
  `,
  styleUrl: './add-runner-step.css',
  styles: `
    .params {
      display: grid;
      gap: var(--space-4);
    }

    .params__quiet {
      display: block;
      color: var(--text-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddRunnerParamsStep {
  readonly formId = input.required<string>();
  readonly projects = input.required<readonly RunnerProjectOption[]>();
  /** `null` while unknown: the D3 line shows (decision 5). */
  readonly ownerCount = input<number | null>(null);
  readonly busy = input(false);
  /** Already translated; `null` when the name is fine. */
  readonly nameError = input<string | null>(null);
  readonly name = model('');
  readonly scope = model<RunnerProjectScope>('all');
  readonly selected = model<readonly string[]>([]);
  readonly platform = model<RunnerPlatform>('mac');
  readonly submitted = output<Event>();

  protected readonly nameMaxLength = RUNNER_NAME_MAX_LENGTH;
}
