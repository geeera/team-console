import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Callout } from '@console/shared/ui';
import type { WizardEnd } from '../add-runner.model';

/** Spec §6 states 9–11: the request ended without a runner; the footer offers «Новая команда». */
@Component({
  selector: 'tc-add-runner-ended-step',
  imports: [Callout, TranslocoPipe],
  template: `
    <section tc-callout [tone]="reason() === 'expired' ? 'warning' : 'neutral'" [attr.data-testid]="'wizard-' + reason()">
      <h3 tc-callout-title class="step__heading" tabindex="-1" data-step-heading>
        {{ 'runners.wizard.' + reason() + '.title' | transloco }}
      </h3>
      <p>{{ body() | transloco }}</p>
    </section>
  `,
  styleUrl: './add-runner-step.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddRunnerEndedStep {
  readonly reason = input.required<WizardEnd>();

  protected readonly body = computed(() => `runners.wizard.${this.reason()}.body`);
}
