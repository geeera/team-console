import { inject, Injectable } from '@angular/core';
import type { RunnerProjectOption } from '@console/entities/runner';
import { TranslocoService } from '@console/shared/i18n';
import { Sheet } from '@console/shared/ui';
import { firstValueFrom } from 'rxjs';
import { EnrolRunnerDialog, type EnrolRunnerData } from './enrol-runner-dialog';

export interface EnrolRunnerTarget {
  readonly accountId: string;
  readonly projects: readonly RunnerProjectOption[];
}

/**
 * "New runner" on Settings › Runners (#464): opens the enrolment dialog. Resolves `true` when a code was issued (the
 * runner appears in the list once it has run `enrol` on its host), `false` when the owner backed out.
 */
@Injectable({ providedIn: 'root' })
export class EnrolRunner {
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);

  async open(target: EnrolRunnerTarget): Promise<boolean> {
    const ref = this.sheet.open<boolean, EnrolRunnerData>(EnrolRunnerDialog, {
      title: this.transloco.translate('runners.enrol.title'),
      width: 'wide',
      autoFocus: '[data-testid="enrol-name"]',
      data: { accountId: target.accountId, projects: target.projects },
    });
    return (await firstValueFrom(ref.closed)) === true;
  }
}
