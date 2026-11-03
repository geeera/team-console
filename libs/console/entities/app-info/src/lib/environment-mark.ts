import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Chip, type ChipTone } from '@console/shared/ui';
import { environmentLabelOf, type Environment } from '@shared/contracts';
import { DeploymentStore } from './deployment.store';

// The same palette as the icon bands of tools/env-icons (#237); the label carries the meaning, the tone only helps.
const TONES: Readonly<Record<Environment, ChipTone>> = {
  local: 'neutral',
  dev: 'warning',
  stage: 'danger',
  production: 'neutral',
};

/**
 * Which environment the app runs against, shown in the shell outside production (#237): "Dev", "Stage" or "Local"
 * as text, so dev is never mistaken for production. Nothing at all in production or while the environment is unknown.
 */
@Component({
  selector: 'tc-environment-mark',
  imports: [Chip, TranslocoPipe],
  template: `
    @if (mark(); as mark) {
      <tc-chip [tone]="mark.tone" data-testid="environment-mark">
        <span class="tc-sr-only">{{ 'app.environment' | transloco }}</span>
        {{ mark.label }}
      </tc-chip>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-environment-mark' },
})
export class EnvironmentMark {
  private readonly deployment = inject(DeploymentStore);

  protected readonly mark = computed(() => {
    const environment = this.deployment.environment();
    const label = environment === null ? null : environmentLabelOf(environment);
    return environment === null || label === null ? null : { label, tone: TONES[environment] };
  });

  constructor() {
    void this.deployment.ensureLoaded();
  }
}
