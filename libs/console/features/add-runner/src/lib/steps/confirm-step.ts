import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LocalTimePipe, TranslocoPipe } from '@console/shared/i18n';
import { Callout, Ledger, LedgerRow } from '@console/shared/ui';
import type { EnrolmentIntentDto } from '@shared/contracts';
import { countryLabelOf, fingerprintSpokenOf, minutesLeftOf } from '../add-runner.model';

/**
 * Step 3 «Подтверждение» (spec §3.3, R-INT-1, R-INT-7): the bound machine's fingerprint, the only identity, large and
 * spelled out for a screen reader; the host fields and the bind country as plain text in `<bdi>`, never markup or a
 * link. The buttons live in the wizard's footer, and none of them is the default action.
 */
@Component({
  selector: 'tc-add-runner-confirm-step',
  imports: [Callout, Ledger, LedgerRow, LocalTimePipe, TranslocoPipe],
  template: `
    @let bound = intent();
    <h3 class="step__heading" tabindex="-1" data-step-heading>
      {{ 'runners.wizard.confirm.title' | transloco }}
    </h3>
    <section tc-callout tone="warning">
      <p tc-callout-title>{{ 'runners.wizard.confirm.compareTitle' | transloco }}</p>
      <p>{{ 'runners.wizard.confirm.compareBody' | transloco }}</p>
    </section>
    <div class="confirm__code">
      <p class="step__meta">{{ 'runners.wizard.confirm.fingerprint' | transloco }}</p>
      <p class="confirm__fingerprint">
        <span aria-hidden="true" data-testid="wizard-fingerprint">{{ bound.fingerprint }}</span>
        <span class="tc-sr-only">{{ spokenWith('runners.wizard.fingerprintDash' | transloco) }}</span>
      </p>
    </div>
    <dl tc-ledger class="confirm__ledger" data-testid="wizard-host">
      <div tc-ledger-row [label]="'runners.wizard.confirm.host' | transloco">
        <bdi dir="auto" class="step__value" data-testid="wizard-hostname">{{ bound.host?.hostname }}</bdi>
      </div>
      <div tc-ledger-row [label]="'runners.wizard.confirm.system' | transloco">
        <bdi dir="auto" class="step__value">{{ bound.host?.os }} · {{ bound.host?.arch }}</bdi>
      </div>
      <div tc-ledger-row [label]="'runners.wizard.confirm.version' | transloco">
        <bdi dir="auto" class="step__value">{{ bound.version }}</bdi>
      </div>
      <div tc-ledger-row [label]="'runners.wizard.confirm.isolation' | transloco">
        {{ 'runners.backend.' + bound.isolation | transloco }}
      </div>
      <div tc-ledger-row [label]="'runners.wizard.confirm.country' | transloco">
        <bdi dir="auto" data-testid="wizard-country">{{
          country() ?? ('runners.wizard.confirm.countryUnknown' | transloco)
        }}</bdi>
      </div>
      @if (bound.boundAt; as boundAt) {
        <div tc-ledger-row [label]="'runners.wizard.confirm.boundAt' | transloco">
          {{ boundAt | localTime }}
        </div>
      }
    </dl>
    <details>
      <summary class="confirm__summary">{{ 'runners.wizard.confirm.takenQ' | transloco }}</summary>
      <p class="step__meta">{{ 'runners.wizard.confirm.takenA' | transloco }}</p>
    </details>
    <p class="step__meta" data-testid="wizard-expiry">
      {{
        'runners.wizard.expires' | transloco: { time: bound.expiresAt | localTime, minutes: minutesLeft() }
      }}
    </p>
  `,
  styleUrl: './add-runner-step.css',
  styles: `
    .confirm__code p {
      margin: 0;
    }

    .confirm__fingerprint {
      font-family: var(--font-mono);
      font-size: var(--fs-2xl);
      font-weight: var(--fw-semibold);
    }

    .confirm__summary {
      min-height: var(--control-h-touch);
      display: flex;
      align-items: center;
      cursor: pointer;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddRunnerConfirmStep {
  readonly intent = input.required<EnrolmentIntentDto>();
  readonly now = input.required<number>();
  /** The UI language, for the country's name. */
  readonly lang = input('ru');

  protected readonly country = computed(() => countryLabelOf(this.intent().boundCountry, this.lang()));
  protected readonly minutesLeft = computed(() => minutesLeftOf(this.intent().expiresAt, this.now()));

  /** Read character by character, the way it is compared with the terminal. */
  protected spokenWith(dashWord: string): string {
    return fingerprintSpokenOf(this.intent().fingerprint ?? '', dashWord);
  }
}
