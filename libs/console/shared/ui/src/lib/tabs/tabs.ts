import {
  afterNextRender,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChildren,
  ElementRef,
  forwardRef,
  inject,
  Injector,
  input,
  model,
  OnInit,
  signal,
  viewChildren,
} from '@angular/core';

let nextTabsId = 0;

/**
 * Sections of one screen behind a segmented tab list (WAI-ARIA APG tabs, automatic activation): ←/→ move and wrap,
 * Home/End jump to the ends, Tab goes on into the panel. Each `tc-tab-panel` names its tab with `label` ("PR 4").
 *
 * With `[enabled]="false"` (a wide screen with room for every section) there is no tab list and every panel is a
 * plain block, laid out by the caller; the selection is kept for when the tabs come back.
 *
 * ```html
 * <tc-tabs label="Board sections" [enabled]="isPhone()" [(selected)]="tab">
 *   <tc-tab-panel key="tasks" label="Tasks 20">…</tc-tab-panel>
 *   <tc-tab-panel key="pulls" label="PR 4">…</tc-tab-panel>
 * </tc-tabs>
 * ```
 */
@Component({
  selector: 'tc-tabs',
  template: `
    @if (isActive()) {
      <div class="tc-tabs__list" role="tablist" [attr.aria-label]="label()">
        @for (panel of panels(); track panel.key(); let index = $index) {
          <button
            #tab
            class="tc-tabs__tab"
            type="button"
            role="tab"
            [id]="panel.tabId"
            [attr.aria-controls]="panel.panelId"
            [attr.aria-selected]="panel.key() === activeKey()"
            [tabIndex]="panel.key() === activeKey() ? 0 : -1"
            (click)="selectAt(index, false)"
            (keydown)="onKey($event, index)"
          >
            {{ panel.label() }}
          </button>
        }
      </div>
    }
    <ng-content />
  `,
  styleUrl: './tabs.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-tabs', '[class.tc-tabs--active]': 'isActive()' },
})
export class Tabs {
  private readonly injector = inject(Injector);
  /** The tab list's accessible name. */
  readonly label = input.required<string>();
  /** The selected panel's key; `null` (or a key no panel has) means the first panel. */
  readonly selected = model<string | null>(null);
  /** `false`: no tab list, every panel shown. */
  readonly enabled = input(true, { transform: booleanAttribute });

  // forwardRef: TabPanel is declared below and injects Tabs.
  private readonly children = contentChildren(forwardRef(() => TabPanel));
  /** Panels past their first input pass (see `Lanes.lanes` for why). */
  protected readonly panels = computed(() => this.children().filter((panel) => panel.ready()));
  private readonly tabs = viewChildren<ElementRef<HTMLButtonElement>>('tab');

  /** One panel needs no tab list. */
  readonly isActive = computed(() => this.enabled() && this.panels().length >= 2);

  readonly activeKey = computed(() => {
    const panels = this.panels();
    const selected = this.selected();
    return selected !== null && panels.some((panel) => panel.key() === selected)
      ? selected
      : (panels[0]?.key() ?? null);
  });

  /** Selects `key` (ignored when no panel has it); `focusPanel` then moves focus into that panel, as a jump does. */
  select(key: string, options: { readonly focusPanel?: boolean } = {}): void {
    const panel = this.panels().find((candidate) => candidate.key() === key);
    if (panel === undefined) {
      return;
    }
    this.selected.set(key);
    if (options.focusPanel === true) {
      // The panel is still hidden until the selection renders; a hidden element cannot take focus.
      afterNextRender(() => panel.focus(), { injector: this.injector });
    }
  }

  protected selectAt(index: number, moveFocus: boolean): void {
    const panel = this.panels()[index];
    if (panel === undefined) {
      return;
    }
    if (moveFocus) {
      this.tabs()[index]?.nativeElement.focus();
    }
    this.selected.set(panel.key());
  }

  protected onKey(event: KeyboardEvent, index: number): void {
    const last = this.panels().length - 1;
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
    this.selectAt(target, true);
  }
}

/**
 * One section of `tc-tabs`. With the tabs on, it is the tab panel of its tab (hidden unless selected) and can take
 * focus from a script (`tabindex="-1"`), so a jump to it lands inside; with them off it is a plain block.
 */
@Component({
  selector: 'tc-tab-panel',
  template: '<ng-content />',
  styleUrl: './tab-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-tab-panel',
    '[id]': 'panelId',
    '[attr.role]': 'isTabbed() ? "tabpanel" : null',
    '[attr.aria-labelledby]': 'isTabbed() ? tabId : null',
    '[attr.tabindex]': 'isTabbed() ? -1 : null',
    '[hidden]': 'isTabbed() && !isSelected()',
  },
})
export class TabPanel implements OnInit {
  private readonly tabs = inject(Tabs);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly key = input.required<string>();
  /** The tab's text, count included ("PR 4"). */
  readonly label = input.required<string>();

  readonly ready = signal(false);

  private readonly id = nextTabsId++;
  readonly panelId = `tc-tab-panel-${this.id}`;
  readonly tabId = `tc-tab-${this.id}`;

  protected readonly isTabbed = computed(() => this.tabs.isActive());
  protected readonly isSelected = computed(() => this.tabs.activeKey() === this.key());

  ngOnInit(): void {
    this.ready.set(true);
  }

  /** Focus the panel itself (tabs on) — a jump from elsewhere on the page lands here. */
  focus(): void {
    this.host.nativeElement.focus();
  }
}
