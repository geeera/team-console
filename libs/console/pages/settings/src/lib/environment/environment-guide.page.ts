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
import { setupCommandOf, type ManifestGuide } from '@shared/environment';
import { ROW_STATUS_ICONS } from './environment-row';
import { EnvironmentScreen } from './environment-screen';

type GuideSection = 'scopes' | 'rotation' | 'gotchas';

const SECTIONS: readonly GuideSection[] = ['scopes', 'rotation', 'gotchas'];

/**
 * One item's guide (#104), rendered from the manifest only — the same text `setup` prints (owner decision
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
   * Route params (component input binding, which sets a param the route lacks to `undefined`): `place` on a
   * Worker or GitHub guide, `slug` on a per-project one.
   */
  readonly place = input<string | undefined>(undefined);
  readonly name = input.required<string>();
  readonly slug = input<string | undefined>(undefined);

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly env = this.screen.environment;
  protected readonly id = computed(() => {
    const slug = this.slug();
    return slug === undefined ? `${this.place() ?? ''}/${this.name()}` : `project/${slug}/${this.name()}`;
  });
  protected readonly view = computed(() => this.screen.rowById(this.id()));
  /** A per-project guide opened by URL waits for the projects before it says "no such setting". */
  protected readonly waiting = computed(
    () => this.view() === null && this.slug() !== undefined && !this.screen.projectsSettled(),
  );
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
  protected readonly setCommand = computed(() => setupCommandOf(this.env()));
  protected readonly rotateCommand = computed(() => setupCommandOf(this.env(), 'rotate'));
  protected readonly checkCommand = computed(() => setupCommandOf(this.env(), 'check'));
  protected readonly backLink = computed(() => ['/settings/environment', this.env()]);

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
