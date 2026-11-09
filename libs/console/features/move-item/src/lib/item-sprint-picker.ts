import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  calendarTodayOf,
  freezeDaysOrDefault,
  ItemsApi,
  newIdempotencyKey,
  openSprintsOf,
  type FailedWrite,
} from '@console/entities/item';
import { localCalendarDayOf, pluralKeyOf, TranslocoService } from '@console/shared/i18n';
import { Menu, PickerButton, Toaster } from '@console/shared/ui';
import type { ItemDto, TrackerSprintDto } from '@shared/contracts';
import { moveMenuOf, moveTargetOf, SPRINT_CAP, type MoveTarget } from './move-menu';

/**
 * Sprint ▾ on the task screen (#409 §2.2): the Move menu — every open sprint and the backlog — and a move that
 * applies at once (`PATCH {sprint}` with `If-Match` and an idempotency key). The toast then says "TC-408 → Sprint 04"
 * and offers Undo for 10 s (⌘Z / Ctrl+Z), which moves it back on the version the move produced. A move keeps the
 * status. Focus stays on Sprint ▾ (the task does not leave this screen).
 */
@Component({
  selector: 'tc-item-sprint-picker',
  imports: [PickerButton],
  template: `
    <button
      #button
      tc-picker
      type="button"
      data-testid="pick-sprint"
      [field]="label()"
      [value]="value()"
      [expanded]="isOpen()"
      [off]="isOff()"
      [attr.aria-describedby]="off() !== null ? 'tc-task-off' : null"
      (click)="open()"
    >
      <i aria-hidden="true"></i>
    </button>
  `,
  styles: ':host { display: contents; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemSprintPicker {
  private readonly api = inject(ItemsApi);
  private readonly menu = inject(Menu);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly button = viewChild.required('button', { read: ElementRef<HTMLButtonElement> });

  readonly slug = input.required<string>();
  readonly item = input.required<ItemDto>();
  /** The sprint as the screen shows it ("Sprint 03 — current", "Backlog"). */
  readonly value = input.required<string>();
  readonly off = input<string | null>(null);
  readonly changed = output<ItemDto>();
  readonly failed = output<FailedWrite>();

  protected readonly isOpen = signal(false);
  private readonly isBusy = signal(false);
  protected readonly isOff = computed(() => this.off() !== null || this.isBusy());
  protected readonly label = computed(() => this.transloco.translate('item.sprint'));
  /** A seam for specs. */
  now: () => Date = () => new Date();

  async open(): Promise<void> {
    if (this.isOpen() || this.isOff()) {
      return;
    }
    this.isOpen.set(true);
    this.isBusy.set(true);
    const [sprints, open, freezeDays] = await Promise.all([
      this.api.sprints(this.slug()),
      this.api.items(this.slug(), { state: 'open' }),
      this.api.freezeDays(this.slug()),
    ]);
    this.isBusy.set(false);
    if (!sprints.ok || !open.ok) {
      this.isOpen.set(false);
      this.failed.emit({
        failure: { kind: sprints.ok && open.ok ? 'unknown' : 'network', field: null, retryAfter: null },
        retry: () => this.open(),
      });
      return;
    }
    const counts = new Map<number | null, number>();
    for (const entry of open.value) {
      counts.set(entry.sprint, (counts.get(entry.sprint) ?? 0) + 1);
    }
    const item = this.item();
    const openSprints = openSprintsOf(sprints.value);
    const picked = await this.menu.open(
      this.button().nativeElement,
      moveMenuOf(
        {
          item,
          sprints: openSprints,
          counts,
          today: calendarTodayOf(this.now()),
          freezeDays: freezeDaysOrDefault(freezeDays),
        },
        this.copy(item),
      ),
    );
    this.isOpen.set(false);
    const target = picked === null ? undefined : moveTargetOf(picked);
    if (target === undefined || target === item.sprint) {
      return;
    }
    await this.move(item, target, item.version, newIdempotencyKey(), openSprints, false);
  }

  private async move(
    item: ItemDto,
    to: MoveTarget,
    version: number,
    key: string,
    sprints: readonly TrackerSprintDto[],
    isUndo: boolean,
  ): Promise<void> {
    this.isBusy.set(true);
    const result = await this.api.update(this.slug(), item.number, version, { sprint: to }, key);
    this.isBusy.set(false);
    if (!result.ok) {
      this.failed.emit({
        failure: result.failure,
        retry: () => this.move(item, to, version, key, sprints, isUndo),
      });
      return;
    }
    const moved = result.value;
    this.changed.emit(moved);
    this.button().nativeElement.focus();
    const where = this.whereOf(to, sprints);
    if (isUndo) {
      const undone = this.t('plan.undone', { key: moved.key, where });
      this.toaster.show(undone);
      void this.announcer.announce(undone, 'polite');
      return;
    }
    const from = item.sprint;
    this.toaster.offerUndo(this.t('plan.moved', { key: moved.key, where }), {
      label: this.t('plan.undo'),
      run: () => void this.move(moved, from, moved.version, newIdempotencyKey(), sprints, true),
    });
  }

  private whereOf(target: MoveTarget, sprints: readonly TrackerSprintDto[]): string {
    if (target === null) {
      return this.t('plan.backlog');
    }
    return (
      sprints.find((sprint) => sprint.number === target)?.title ?? `Sprint ${String(target).padStart(2, '0')}`
    );
  }

  private copy(item: ItemDto) {
    const lang = this.transloco.getActiveLang();
    const day = (sprint: TrackerSprintDto): string =>
      sprint.dueOn === null ? '' : localCalendarDayOf(sprint.dueOn, lang);
    const counted = (key: string, n: number, params: Record<string, unknown> = {}): string =>
      this.t(pluralKeyOf(key, lang, n), { n, ...params });
    return {
      label: this.t('plan.menuAria', { key: item.key }),
      title: this.t('plan.menuTitle', { key: item.key }),
      sprintsGroup: this.t('plan.sprints'),
      to: (sprint: TrackerSprintDto) => this.t('plan.to', { sprint: sprint.title }),
      toCurrent: (sprint: TrackerSprintDto) => this.t('plan.toCurrent', { sprint: sprint.title }),
      toBacklog: this.t('plan.toBacklog'),
      count: (n: number, sprint: TrackerSprintDto) =>
        sprint.dueOn === null
          ? counted('plan.backlogCount', n)
          : counted('plan.count', n, { date: day(sprint) }),
      backlogCount: (n: number) => counted('plan.backlogCount', n),
      full: (n: number) => counted('plan.full', n, { cap: SPRINT_CAP }),
      here: this.t('plan.here'),
      freeze: (sprint: TrackerSprintDto) => this.t('plan.freeze', { date: day(sprint) }),
      inProgress: this.t('plan.inProgressWarn'),
    };
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
