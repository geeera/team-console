import {
  computed,
  Directive,
  inject,
  Injectable,
  input,
  OnDestroy,
  OnInit,
  signal,
  TemplateRef,
  ViewContainerRef,
  WritableSignal,
} from '@angular/core';

/** `primary`: the main action(s); `secondary`: Cancel and the rest; `''`: free-form content laid out as written. */
export type SheetFooterRole = 'primary' | 'secondary' | '';

/** The footer a sheet's content hands to its frame: one template per role, one slot per opened sheet. */
@Injectable()
export class SheetFooterSlot {
  readonly freeForm = signal<TemplateRef<unknown> | null>(null);
  readonly primary = signal<TemplateRef<unknown> | null>(null);
  readonly secondary = signal<TemplateRef<unknown> | null>(null);
  readonly hasContent = computed(
    () => this.freeForm() !== null || this.primary() !== null || this.secondary() !== null,
  );

  signalOf(role: SheetFooterRole): WritableSignal<TemplateRef<unknown> | null> {
    return role === 'primary' ? this.primary : role === 'secondary' ? this.secondary : this.freeForm;
  }
}

/**
 * Actions that stay at the bottom of a sheet or dialog while its body scrolls (#194 design). The frame lays them out
 * in reading order on both presentations (#282, WCAG 2.4.3): stacked full width with the primary on top on the
 * phone, a row with the primary on the right in the dialog — so the content names the role of each template and the
 * frame decides the DOM order, which is then also the Tab order.
 *
 * ```html
 * <ng-template tcSheetFooter="primary">
 *   <button tc-button variant="primary" type="button">Done</button>
 * </ng-template>
 * <ng-template tcSheetFooter="secondary">
 *   <button tc-button type="button">Cancel</button>
 * </ng-template>
 * ```
 *
 * A bare `tcSheetFooter` is free-form: rendered as written, before the roles. Outside a sheet (a story, a test) every
 * template renders where it stands.
 */
@Directive({ selector: 'ng-template[tcSheetFooter]' })
export class SheetFooter implements OnInit, OnDestroy {
  readonly role = input<SheetFooterRole>('', { alias: 'tcSheetFooter' });

  private readonly slot = inject(SheetFooterSlot, { optional: true });
  private readonly template = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly container = inject(ViewContainerRef);

  ngOnInit(): void {
    if (this.slot === null) {
      this.container.createEmbeddedView(this.template);
      return;
    }
    this.slot.signalOf(this.role()).set(this.template);
  }

  ngOnDestroy(): void {
    const target = this.slot?.signalOf(this.role());
    if (target !== undefined && target() === this.template) {
      target.set(null);
    }
  }
}
