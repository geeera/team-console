import { BreakpointObserver } from '@angular/cdk/layout';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChildren,
  forwardRef,
  inject,
  input,
  model,
  numberAttribute,
  OnInit,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { map, switchMap } from 'rxjs';
import { BREAKPOINTS, type Breakpoint } from '../../tokens/breakpoints';

let nextLaneId = 0;

export type LaneHeadingLevel = 2 | 3 | 4;

/** The side the incoming lane slides in from, after the owner switched lanes. */
type LaneDirection = 'forward' | 'backward';

/**
 * Lanes of a board: stacked on wider screens. On a narrow screen (`compactBelow`, the phone by default), with two or
 * more lanes, a one-row switcher sits on top — one equal cell per lane, its name above its count, never a second
 * row — and only the selected lane is shown, at its own height, so whatever follows the board starts right under it.
 * The switcher is a named group of toggle buttons (`aria-pressed`, #275 §6); a lane with nothing in it is dimmed and
 * still focusable.
 *
 * Name it with `label` (the group's name either way). Each lane is picked by its `key` (its heading by default). The
 * selection defaults to the first `preferred` key whose lane has items, else the first lane with items, else the
 * first, and falls back to that when the selected lane is gone; bind `[(selected)]` to keep it when the lanes are
 * rendered anew.
 *
 * ```html
 * <tc-lanes label="Issues by status" compactBelow="tablet" [preferred]="['blocked']" [(selected)]="lane">
 *   <tc-lane key="in-progress" heading="In progress" [count]="2"><tc-list>…</tc-list></tc-lane>
 * </tc-lanes>
 * ```
 */
@Component({
  selector: 'tc-lanes',
  template: `
    @if (tabbed()) {
      <div class="tc-lanes__switch" role="group" [attr.aria-label]="label()">
        @for (lane of lanes(); track lane.laneKey(); let index = $index) {
          <button
            class="tc-lanes__cell"
            type="button"
            [class.tc-lanes__cell--empty]="lane.count() === 0"
            [id]="lane.tabId"
            [attr.aria-controls]="lane.panelId"
            [attr.aria-pressed]="lane.laneKey() === activeKey()"
            (click)="select(index)"
          >
            <!-- The hidden comma is for the name only: "Blocked, 3" reads as a lane and its count. -->
            <span class="tc-lanes__cell-name">{{ lane.heading() }}</span
            ><span class="tc-sr-only">, </span><span class="tc-lanes__cell-count">{{ lane.count() }}</span>
          </button>
        }
      </div>
    }
    <ng-content />
  `,
  styleUrl: './lanes.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-lanes',
    '[class.tc-lanes--tabbed]': 'tabbed()',
    // With the switcher, its group carries the name; the wrapper then has no role.
    '[attr.role]': 'tabbed() ? null : "group"',
    '[attr.aria-label]': 'tabbed() ? null : label()',
  },
})
export class Lanes {
  private readonly breakpoints = inject(BreakpointObserver);

  /** The accessible name: the group's on wider screens, the switcher's on a narrow one. */
  readonly label = input<string | null>(null);
  /** The selected lane's key; `null` (or a key no lane has) means the default lane. */
  readonly selected = model<string | null>(null);
  /** Below this breakpoint the lanes are shown one at a time, behind the switcher. */
  readonly compactBelow = input<Breakpoint>('phone');
  /** Keys to open on, in order, when their lane has items (a board opens on its blockers). */
  readonly preferred = input<readonly string[]>([]);

  // forwardRef: Lane is declared below and injects Lanes, so one of the two has to come first.
  private readonly children = contentChildren(forwardRef(() => Lane));
  /**
   * A lane's host bindings ask which lane is selected before a sibling rendered after it has its inputs, so only
   * lanes past their first input pass take part; a later one joining re-runs the bindings through the signals.
   */
  protected readonly lanes = computed(() => this.children().filter((lane) => lane.ready()));

  private readonly narrow = toSignal(
    toObservable(this.compactBelow).pipe(
      switchMap((breakpoint) => this.breakpoints.observe(BREAKPOINTS[breakpoint])),
      map((result) => result.matches),
    ),
    { initialValue: this.breakpoints.isMatched(BREAKPOINTS.phone) },
  );

  /** One lane needs no switcher: it is shown stacked, heading and all. */
  readonly tabbed = computed(() => this.narrow() && this.lanes().length >= 2);

  readonly activeKey = computed(() => {
    const lanes = this.lanes();
    const selected = this.selected();
    if (selected !== null && lanes.some((lane) => lane.laneKey() === selected)) {
      return selected;
    }
    const withItems = lanes.filter((lane) => lane.count() > 0);
    const preferred = this.preferred().find((key) => withItems.some((lane) => lane.laneKey() === key));
    return preferred ?? (withItems[0] ?? lanes[0])?.laneKey() ?? null;
  });

  /** Set only by a switch, so the first render and a refresh show the lane without motion. */
  readonly direction = signal<LaneDirection | null>(null);

  protected select(index: number): void {
    const lanes = this.lanes();
    const target = lanes[index];
    if (target === undefined) {
      return;
    }
    const from = lanes.findIndex((lane) => lane.laneKey() === this.activeKey());
    if (index === from) {
      return;
    }
    this.direction.set(index > from ? 'forward' : 'backward');
    this.selected.set(target.laneKey());
  }
}

/**
 * One titled group of a board: a heading with the item count, then the caller's content (usually a `tc-list`, or
 * a compact empty `tc-state-block`). The heading level fits the page outline (3 by default). Behind a `tc-lanes`
 * switcher only the selected lane is shown; its heading stays for heading navigation, visually hidden. A control
 * marked `tc-lane-action` (e.g. "Show") sits at the end of the heading's row.
 */
@Component({
  selector: 'tc-lane',
  template: `
    <div class="tc-lane__bar">
      <div
        class="tc-lane__head"
        role="heading"
        [class.tc-sr-only]="tabbed()"
        [attr.aria-level]="level()"
        [id]="headingId"
      >
        <!-- &ngsp; keeps one space so the heading reads "In progress 2", not "In progress2". -->
        <span class="tc-lane__title">{{ heading() }}</span
        >&ngsp;<span class="tc-lane__count">{{ count() }}</span>
      </div>
      <!-- Beside the heading, never inside it: a control would join the heading's name. -->
      <ng-content select="[tc-lane-action]" />
    </div>
    <ng-content />
  `,
  styleUrl: './lane.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-lane',
    role: 'group',
    '[id]': 'panelId',
    '[attr.aria-labelledby]': 'headingId',
    '[hidden]': 'tabbed() && !isSelected()',
    '[class.tc-lane--enter-forward]': 'enteringFrom() === "forward"',
    '[class.tc-lane--enter-backward]': 'enteringFrom() === "backward"',
  },
})
export class Lane implements OnInit {
  private readonly lanes = inject(Lanes, { optional: true });

  /** Set once the inputs are bound; see `Lanes.lanes`. */
  readonly ready = signal(false);

  readonly heading = input.required<string>();
  readonly count = input.required({ transform: numberAttribute });
  readonly level = input<LaneHeadingLevel>(3);
  /** Identifies the lane across renders (e.g. a status); the heading when not given. */
  readonly key = input<string | null>(null);

  private readonly id = nextLaneId++;
  protected readonly headingId = `tc-lane-heading-${this.id}`;
  readonly panelId = `tc-lane-${this.id}`;
  /** The id of its cell in the switcher. */
  readonly tabId = `tc-lane-tab-${this.id}`;

  readonly laneKey = computed(() => this.key() ?? this.heading());
  protected readonly tabbed = computed(() => this.lanes?.tabbed() ?? false);
  protected readonly isSelected = computed(() => this.lanes?.activeKey() === this.laneKey());
  protected readonly enteringFrom = computed(() =>
    this.tabbed() && this.isSelected() ? (this.lanes?.direction() ?? null) : null,
  );

  ngOnInit(): void {
    this.ready.set(true);
  }
}
