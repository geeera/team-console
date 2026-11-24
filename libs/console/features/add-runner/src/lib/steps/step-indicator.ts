import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { WIZARD_STEPS, type WizardStep } from '../add-runner.model';

/**
 * «Шаг 2 из 4 · Команда», plus the four names as a list on wider screens (spec §0.3). Not a tab list: the steps are
 * not navigable, the flow moves on by itself. Local to this slice: nothing else has a step indicator yet.
 */
@Component({
  selector: 'tc-add-runner-step-indicator',
  imports: [TranslocoPipe],
  template: `
    <p class="indicator__text" data-testid="wizard-step">
      {{ 'runners.wizard.step' | transloco: { n: number(), name: ('runners.wizard.steps.' + step() | transloco) } }}
    </p>
    @if (!compact()) {
      <ol class="indicator__list" [attr.aria-label]="'runners.wizard.stepsLabel' | transloco">
        @for (item of steps; track item) {
          <li [class.indicator__item--current]="item === step()" [attr.aria-current]="item === step() ? 'step' : null">
            {{ 'runners.wizard.steps.' + item | transloco }}
          </li>
        }
      </ol>
    }
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-2);
    }

    .indicator__text {
      margin: 0;
      font-size: var(--fs-sm);
      color: var(--text-2);
    }

    .indicator__list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-4);
      margin: 0;
      padding-inline-start: var(--space-5);
      font-size: var(--fs-sm);
      color: var(--text-3);
    }

    .indicator__item--current {
      color: var(--text);
      font-weight: var(--fw-semibold);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddRunnerStepIndicator {
  readonly step = input.required<WizardStep>();
  /** The phone shows the text line only (spec §7). */
  readonly compact = input(false);

  protected readonly steps = WIZARD_STEPS;
  protected readonly number = computed(() => WIZARD_STEPS.indexOf(this.step()) + 1);
}
