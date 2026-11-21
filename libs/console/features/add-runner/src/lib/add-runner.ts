import { inject, Injectable } from '@angular/core';
import type { RunnerProjectOption } from '@console/entities/runner';
import { TranslocoService } from '@console/shared/i18n';
import { Sheet } from '@console/shared/ui';
import { firstValueFrom } from 'rxjs';
import type { AddRunnerOutcome } from './add-runner.model';
import { AddRunnerWizard, type AddRunnerData } from './add-runner-wizard';

export interface AddRunnerTarget {
  readonly accountId: string;
  readonly projects: readonly RunnerProjectOption[];
  readonly releaseVersion: string | null;
}

/**
 * «Подключить раннер» on Settings › Runners (#634 PR 4): opens the wizard and resolves with what the page should do
 * next — nothing, the code dialog for Linux, or the new runner's scope editor. A wizard closed any other way (a
 * session that expired and closed every sheet) reads as closed with nothing enrolled.
 */
@Injectable({ providedIn: 'root' })
export class AddRunner {
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);

  async open(target: AddRunnerTarget): Promise<AddRunnerOutcome> {
    const ref = this.sheet.open<AddRunnerOutcome, AddRunnerData>(AddRunnerWizard, {
      title: this.transloco.translate('runners.enrol.title'),
      width: 'wide',
      autoFocus: '[data-testid="wizard-name"]',
      data: { accountId: target.accountId, projects: target.projects, releaseVersion: target.releaseVersion },
    });
    return (await firstValueFrom(ref.closed)) ?? { kind: 'closed', enrolled: false };
  }
}
