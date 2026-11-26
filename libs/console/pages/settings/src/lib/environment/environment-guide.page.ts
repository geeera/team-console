import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { guideSourceOf, proseSegmentsOf, type RowStatus } from '@console/entities/environment';
import { ConsoleLanguage, LocalTimePipe, TranslocoPipe } from '@console/shared/i18n';
import { CopyCode, Icon, StateBlock, type IconName } from '@console/shared/ui';
import type { Environment } from '@shared/contracts';
import { setupCommandOf, type ManifestGuide } from '@shared/environment';
import { ROW_STATUS_ICONS } from './environment-row';
import { EnvironmentScreen } from './environment-screen';

type GuideSection = 'scopes' | 'rotation' | 'gotchas';

const SECTIONS: readonly GuideSection[] = ['scopes', 'rotation', 'gotchas'];

/**
 * One item's guide (#104; a project's too, #750), rendered from the manifest only — the same text `setup` prints (owner decision
 * 2026-10-01). A section the manifest leaves empty is left out. The command fits the status: set it when missing,
 * replace it when set, check it when the console cannot see it. Never a value, a length or a prefix.
 */
@Component({
  selector: 'tc-environment-guide-page',
  imports: [CopyCode, Icon, LocalTimePipe, NgTemplateOutlet, RouterLink, StateBlock, TranslocoPipe],
  templateUrl: './environment-guide.page.html',
  styleUrl: './environment-guide.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnvironmentGuidePage {
  private readonly injector = inject(Injector);
  private readonly language = inject(ConsoleLanguage);

  protected readonly screen = inject(EnvironmentScreen);

  /**
   * Route params (component input binding, which sets a param the route lacks to `undefined`): `place` on an
   * operator guide (its `:env` is the list's), `env` on a project's (`/settings/projects/:slug/environment/:env/:name`).
   */
  readonly place = input<string | undefined>(undefined);
  readonly name = input.required<string>();
  readonly env = input<string | undefined>(undefined);

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  private readonly guideEnvironment = computed(() => this.screen.guideEnvironmentOf(this.env()));
  /** Where the guide's commands point; an unknown `:env` finds no row and reads as not found. */
  protected readonly environment = computed<Environment>(() => this.guideEnvironment() ?? 'production');
  protected readonly id = computed(() => this.screen.guideIdOf({ place: this.place(), name: this.name() }));
  protected readonly view = computed(() => {
    const environment = this.guideEnvironment();
    return environment === null ? null : this.screen.rowAt(environment, this.id());
  });
  protected readonly notFoundLine = computed(() =>
    this.screen.notFoundLineOf(this.env() ?? this.environment()),
  );
  protected readonly backLine = computed(() => this.screen.backLineOf(this.environment()));
  protected readonly item = computed(() => this.view()?.row.item ?? null);
  protected readonly source = computed(() => {
    const item = this.item();
    return item === null ? null : guideSourceOf(item);
  });
  protected readonly isRussian = computed(() => this.language.active() === 'ru');
  protected readonly sections = computed(() => {
    const guide: ManifestGuide | undefined = this.item()?.guide;
    return guide === undefined
      ? []
      : SECTIONS.flatMap((key) => {
          const text = guide[key];
          return text === null ? [] : [{ key, segments: proseSegmentsOf(text) }];
        });
  });
  protected readonly obtain = computed(() => {
    const text = this.item()?.guide.obtain ?? null;
    return text === null ? null : proseSegmentsOf(text);
  });
  protected readonly purpose = computed(() => proseSegmentsOf(this.item()?.purpose ?? ''));
  protected readonly neededBy = computed(() => (this.item()?.neededBy ?? []).join(', '));
  protected readonly setCommand = computed(() => setupCommandOf(this.environment()));
  protected readonly rotateCommand = computed(() => setupCommandOf(this.environment(), 'rotate'));
  protected readonly checkCommand = computed(() => setupCommandOf(this.environment(), 'check'));
  protected readonly backLink = computed(() => this.screen.listRouteOf(this.environment()));

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => {
        this.screen.openId.set(id);
        this.screen.lastOpenedId.set(id);
      });
      afterNextRender(() => this.heading()?.nativeElement.focus(), { injector: this.injector });
    });
    inject(DestroyRef).onDestroy(() => this.screen.openId.set(null));
  }

  protected statusIcon(status: RowStatus): IconName | null {
    return status === 'unknown' ? null : ROW_STATUS_ICONS[status];
  }
}
