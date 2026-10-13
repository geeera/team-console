import { CdkDialogContainer, DialogRef } from '@angular/cdk/dialog';
import { CdkPortalOutlet } from '@angular/cdk/portal';
import { NgTemplateOutlet } from '@angular/common';
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
  InjectionToken,
  signal,
  TemplateRef,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { IconButton } from '../button/button';
import { Icon } from '../icon/icon';
import { SheetFooterSlot } from './sheet-footer';

export interface SheetFrame {
  /** Already translated; rendered as the dialog's heading and its accessible name. */
  readonly title: string;
  readonly titleId: string;
  /** Bottom sheet on the phone, centred dialog elsewhere. */
  readonly presentation: 'sheet' | 'dialog';
  /** `full`: the frame fills its pane and the content owns the scrolling (`SheetOptions.size`). */
  readonly size: 'default' | 'full';
}

export const SHEET_FRAME = new InjectionToken<SheetFrame>('SHEET_FRAME');

/**
 * The frame every sheet and dialog gets: grab handle (sheet only), heading, close button, a scrolling body with the
 * caller's content and, when the content declares one (`tcSheetFooter`), a footer of actions that does not scroll.
 * The CDK container underneath owns the focus trap, focus restore and `aria-modal`; the host bindings are repeated
 * here because a subclass with its own template must declare them itself.
 */
@Component({
  selector: 'tc-sheet-container',
  imports: [CdkPortalOutlet, Icon, IconButton, NgTemplateOutlet, TranslocoPipe],
  templateUrl: './sheet-container.html',
  styleUrl: './sheet-container.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-sheet',
    tabindex: '-1',
    '[class.tc-sheet--dialog]': 'frame.presentation === "dialog"',
    '[class.tc-sheet--full]': 'frame.size === "full"',
    '[class.tc-sheet--with-foot]': 'footer.hasContent()',
    '[attr.id]': '_config.id',
    '[attr.role]': '_config.role',
    '[attr.aria-modal]': '_config.ariaModal',
    '[attr.aria-labelledby]': 'frame.titleId',
    '[attr.aria-describedby]': '_config.ariaDescribedBy || null',
  },
})
export class SheetContainer extends CdkDialogContainer {
  protected readonly frame = inject(SHEET_FRAME);
  protected readonly footer = inject(SheetFooterSlot, { optional: true }) ?? new SheetFooterSlot();
  /**
   * The footer's templates in reading order (#282): free-form content as written, then the primary over the secondary
   * on the phone (stacked, the main action on top) and the secondary before the primary in the dialog (a row, the
   * main action on the right). A dialog footer too narrow for one row stacks like the phone's (#325) and takes the
   * phone's order. DOM order, Tab order and visual order are then one order everywhere.
   */
  protected readonly footerTemplates = computed((): readonly TemplateRef<unknown>[] => {
    const roles =
      this.frame.presentation === 'dialog' && !this.stackedFooter()
        ? [this.footer.secondary(), this.footer.primary()]
        : [this.footer.primary(), this.footer.secondary()];
    return [this.footer.freeForm(), ...roles].filter(
      (template): template is TemplateRef<unknown> => template !== null,
    );
  });
  private readonly ref = inject(DialogRef);
  private readonly injector = inject(Injector);
  private readonly foot = viewChild<ElementRef<HTMLElement>>('foot');
  private readonly body = viewChild.required<ElementRef<HTMLElement>>('body');
  private readonly content = viewChild.required<ElementRef<HTMLElement>>('content');

  /** Whether the body overflows: only then is it a tab stop (the designer's axe finding on #194). */
  protected readonly scrollable = signal(false);

  /** Whether the dialog footer wrapped, so its actions stack full width with the primary on top (#325). */
  protected readonly stackedFooter = signal(false);
  /** The footer width at which it last stacked: a wider footer is worth trying as a row again. */
  private stackedAtWidth = 0;

  constructor() {
    super();
    const destroyRef = inject(DestroyRef);
    effect((onCleanup) => {
      const foot = this.foot()?.nativeElement;
      if (
        foot === undefined ||
        this.frame.presentation !== 'dialog' ||
        typeof ResizeObserver === 'undefined'
      ) {
        return;
      }
      const observer = new ResizeObserver(() => this.fitFooter(foot));
      observer.observe(foot);
      onCleanup(() => observer.disconnect());
    });
    afterNextRender(() => {
      const body = this.body().nativeElement;
      const measure = (): void => this.scrollable.set(body.scrollHeight > body.clientHeight + 1);
      measure();
      if (typeof ResizeObserver === 'undefined') {
        return;
      }
      const observer = new ResizeObserver(measure);
      observer.observe(body);
      observer.observe(this.content().nativeElement);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  /** A wrapped row stacks; a stacked footer that grew wider than when it stacked is tried as a row again. */
  private fitFooter(foot: HTMLElement): void {
    // Free-form content lays itself out; only the role buttons are stacked by the frame.
    if (this.footer.freeForm() !== null) {
      return;
    }
    const width = foot.clientWidth;
    if (!this.stackedFooter()) {
      const [first, ...rest] = Array.from(foot.children) as HTMLElement[];
      if (first !== undefined && rest.some((item) => item.offsetTop > first.offsetTop)) {
        this.stackedAtWidth = width;
        this.restack(foot, true);
      }
    } else if (width > this.stackedAtWidth) {
      this.restack(foot, false);
    }
  }

  /** Reordering moves the buttons in the DOM, which drops focus: put it back on the same button. */
  private restack(foot: HTMLElement, stacked: boolean): void {
    const focused = foot.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    this.stackedFooter.set(stacked);
    if (focused !== null) {
      afterNextRender(() => focused.focus({ preventScroll: true }), { injector: this.injector });
    }
  }

  protected close(): void {
    // Honour the same lock as Escape and the scrim (a confirm dialog sets it while its action runs).
    if (this.ref.disableClose) {
      return;
    }
    this._closeInteractionType = 'mouse';
    this.ref.close();
  }
}
