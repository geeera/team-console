import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { AppInfoStore } from '@console/entities/app-info';
import { connectOutcomeOf } from '@console/entities/github-connection';
import { GitHubConnectionCard } from '@console/features/connect-github';
import { FOCUS_PUSH_SETTINGS_STATE, PushSettingsCard } from '@console/features/push-subscribe';
import { ConsoleLang, ConsoleLanguage, TranslocoPipe } from '@console/shared/i18n';
import { Button, SrOnlyOnPhone } from '@console/shared/ui';
import { readNavigationState } from './settings-navigation';

/**
 * `/settings` (#24): the GitHub connection, notifications, the language switch and the build facts. Settings holds
 * settings only (owner decision on #194): projects are listed and added on All projects.
 */
@Component({
  selector: 'tc-settings-page',
  imports: [Button, GitHubConnectionCard, PushSettingsCard, SrOnlyOnPhone, TranslocoPipe],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  private readonly language = inject(ConsoleLanguage);
  private readonly router = inject(Router);

  protected readonly appInfo = inject(AppInfoStore);

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly pushHeading = viewChild.required<ElementRef<HTMLElement>>('pushHeading');

  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });
  /** The OAuth callback's `?github=` outcome, read once; the query is then dropped so a reload does not repeat it. */
  protected readonly outcome = signal(
    connectOutcomeOf(this.query().get('github'), this.query().get('login')),
  );

  protected readonly otherLang = computed<ConsoleLang>(() => (this.language.active() === 'ru' ? 'en' : 'ru'));

  constructor() {
    // "How to turn on" from the Needs you nudge: the Notifications block, not the top of Settings.
    const toPush = readNavigationState(this.router, FOCUS_PUSH_SETTINGS_STATE) === true;

    if (toPush) {
      afterNextRender(() => {
        const heading = this.pushHeading().nativeElement;
        heading.scrollIntoView({ block: 'start' });
        heading.focus({ preventScroll: true });
      });
    } else if (this.outcome() !== null) {
      void this.router.navigate([], {
        queryParams: { github: null, login: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    } else {
      afterNextRender(() => this.heading().nativeElement.focus());
    }
  }

  /** The whole interface follows at once, and the choice is remembered on this device (#4, #125). */
  protected switchLang(): void {
    this.language.use(this.otherLang());
  }
}
