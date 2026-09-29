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
import { Button } from '@console/shared/ui';

/** Proves the layer chain app → pages → entities → shared; replaced by real screens later. */
@Component({
  selector: 'tc-hello-page',
  imports: [Button, TranslocoPipe],
  templateUrl: './hello.page.html',
  styleUrl: './hello.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HelloPage {
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
