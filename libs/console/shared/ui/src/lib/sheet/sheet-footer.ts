import {
  Directive,
  inject,
  Injectable,
  OnDestroy,
  OnInit,
  signal,
  TemplateRef,
  ViewContainerRef,
} from '@angular/core';

/** The footer a sheet's content hands to its frame; one per opened sheet. */
@Injectable()
export class SheetFooterSlot {
  readonly template = signal<TemplateRef<unknown> | null>(null);
}

/**
 * Actions that stay at the bottom of a sheet or dialog while its body scrolls (#194 design): stacked full width with
 * the primary first on the phone, in a row with the primary on the right in the dialog.
 *
 * ```html
 * <ng-template tcSheetFooter>
 *   <button tc-button variant="primary" type="button">Done</button>
 *   <button tc-button type="button">Open setup</button>
 * </ng-template>
 * ```
 *
 * Outside a sheet (a story, a test) the actions render where the template stands.
 */
@Directive({ selector: 'ng-template[tcSheetFooter]' })
export class SheetFooter implements OnInit, OnDestroy {
  private readonly slot = inject(SheetFooterSlot, { optional: true });
  private readonly template = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly container = inject(ViewContainerRef);

  ngOnInit(): void {
    if (this.slot === null) {
      this.container.createEmbeddedView(this.template);
      return;
    }
    this.slot.template.set(this.template);
  }

  ngOnDestroy(): void {
    if (this.slot?.template() === this.template) {
      this.slot.template.set(null);
    }
  }
}
