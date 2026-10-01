import { BreakpointObserver } from '@angular/cdk/layout';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChildren,
  ElementRef,
  forwardRef,
  inject,
  input,
  model,
  numberAttribute,
  OnInit,
  signal,
  viewChildren,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { BREAKPOINTS } from '../../tokens/breakpoints';

let nextLaneId = 0;

export type LaneHeadingLevel = 2 | 3 | 4;

/** The side the incoming lane slides in from, after the owner switched lanes. */
type LaneDirection = 'forward' | 'backward';

/**
 * Lanes of a board: stacked on wider screens. On the phone, with two or more lanes, a WAI-ARIA tab list of lane pills
 * (name and count) sits on top and only the selected lane is shown, at its own height, so whatever follows the board
 * starts right under it. The tab list is one Tab stop: ←/→ move and wrap, Home/End jump to the ends.
 *
 * Name it with `label` (the group's name on wider screens, the tab list's on the phone). Each lane is picked by
 * its `key` (its heading by default). The selection defaults to the first lane with items, else the first, and falls
 * back to that when the selected lane is gone; bind `[(selected)]` to keep it when the lanes are rendered anew.
 *
 * ```html
 * <tc-lanes label="Issues by status" [(selected)]="lane">
 *   <tc-lane key="in-progress" heading="In progress" [count]="2"><tc-list>…</tc-list></tc-lane>
 * </tc-lanes>
 * ```
 */
@Component({
  selector: 'tc-lanes',
  template: `
    @if (tabbed()) {
      <div class="tc-lanes__tabs" role="tablist" [attr.aria-label]="label()">
        @for (lane of lanes(); track lane.laneKey(); let index = $index) {
          <button
            #tab
            class="tc-lanes__tab"
            type="button"
            role="tab"
            [id]="lane.tabId"
            [attr.aria-controls]="lane.panelId"
            [attr.aria-selected]="lane.laneKey() === activeKey()"
            [tabIndex]="lane.laneKey() === activeKey() ? 0 : -1"
            (click)="select(index, false)"
            (keydown)="onTabKey($event, index)"
          >
            <!-- &ngsp; keeps one space so the tab reads "In progress 2", not "In progress2". -->
            <span class="tc-lanes__tab-name">{{ lane.heading() }}</span
            >&ngsp;<span class="tc-lanes__tab-count">{{ lane.count() }}</span>
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
    // On the phone the tab list carries the name; a wrapper without a role must not.
    '[attr.role]': 'tabbed() ? null : "group"',
    '[attr.aria-label]': 'tabbed() ? null : label()',
  },
})
export class Lanes {
  private readonly breakpoints = inject(BreakpointObserver);

  /** The accessible name: the group's on wider screens, the tab list's on the phone. */
  readonly label = input<string | null>(null);
  /** The selected lane's key; `null` (or a key no lane has) means the default lane. */
  readonly selected = model<string | null>(null);

  // forwardRef: Lane is declared below and injects Lanes, so one of the two has to come first.
  private readonly children = contentChildren(forwardRef(() => Lane));
  /**
   * A lane's host bindings ask which lane is selected before a sibling rendered after it has its inputs, so only
   * lanes past their first input pass take part; a later one joining re-runs the bindings through the signals.
   */
  protected readonly lanes = computed(() => this.children().filter((lane) => lane.ready()));
  private readonly tabs = viewChildren<ElementRef<HTMLButtonElement>>('tab');

  private readonly phone = toSignal(
    this.breakpoints.observe(BREAKPOINTS.phone).pipe(map((result) => result.matches)),
    { initialValue: this.breakpoints.isMatched(BREAKPOINTS.phone) },
  );

  /** One lane needs no switcher: it is shown stacked, heading and all. */
  readonly tabbed = computed(() => this.phone() && this.lanes().length >= 2);

  readonly activeKey = computed(() => {
    const lanes = this.lanes();
    const selected = this.selected();
    if (selected !== null && lanes.some((lane) => lane.laneKey() === selected)) {
      return selected;
    }
    return (lanes.find((lane) => lane.count() > 0) ?? lanes[0])?.laneKey() ?? null;
  });

  /** Set only by a switch, so the first render and a refresh show the lane without motion. */
  readonly direction = signal<LaneDirection | null>(null);

  protected select(index: number, moveFocus: boolean): void {
    const lanes = this.lanes();
    const target = lanes[index];
    if (target === undefined) {
      return;
    }
    if (moveFocus) {
      this.tabs()[index]?.nativeElement.focus();
    }
    const from = lanes.findIndex((lane) => lane.laneKey() === this.activeKey());
    if (index === from) {
      return;
    }
    this.direction.set(index > from ? 'forward' : 'backward');
    this.selected.set(target.laneKey());
  }

  /** WAI-ARIA APG tabs with automatic activation: the panels are rendered already, so switching is free. */
  protected onTabKey(event: KeyboardEvent, index: number): void {
    const last = this.lanes().length - 1;
    const next: Readonly<Record<string, number>> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const target = next[event.key];
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    this.select(target, true);
  }
}

/**
 * One titled group of a board: a heading with the item count, then the caller's content (usually a `tc-list`, or
 * a compact empty `tc-state-block`). The heading level fits the page outline (3 by default). Inside a phone's
 * `tc-lanes` tab list it is the tab panel of its pill; its heading stays for heading navigation, visually hidden.
 */
@Component({
  selector: 'tc-lane',
  template: `
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
    <ng-content />
  `,
  styleUrl: './lane.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-lane',
    '[id]': 'panelId',
    '[attr.role]': 'tabbed() ? "tabpanel" : "group"',
    '[attr.aria-labelledby]': 'tabbed() ? tabId : headingId',
    '[hidden]': 'tabbed() && !isSelected()',
    // An empty panel has nothing to focus, so the panel itself takes the Tab stop and reads its empty block.
    '[attr.tabindex]': 'tabbed() && count() === 0 ? 0 : null',
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
