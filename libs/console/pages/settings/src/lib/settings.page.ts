import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { AppInfoStore } from '@console/entities/app-info';
import {
  ConsoleLang,
  DEFAULT_LANG,
  isConsoleLang,
  TranslocoPipe,
  TranslocoService,
} from '@console/shared/i18n';
import { Button, StateBlock } from '@console/shared/ui';

/**
 * `/settings`: the language switch (until #4 gives it a proper control) and a placeholder for the
 * GitHub connection and the project list (#24). Also the "add a project" entry point of the shell.
 */
@Component({
  selector: 'tc-settings-page',
  imports: [Button, StateBlock, TranslocoPipe],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  private readonly transloco = inject(TranslocoService);

  protected readonly appInfo = inject(AppInfoStore);

  private readonly activeLang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected readonly otherLang = computed<ConsoleLang>(() => {
    const current = this.activeLang();
    return isConsoleLang(current) && current === DEFAULT_LANG ? 'en' : DEFAULT_LANG;
  });

  protected switchLang(): void {
    this.transloco.setActiveLang(this.otherLang());
  }
}
