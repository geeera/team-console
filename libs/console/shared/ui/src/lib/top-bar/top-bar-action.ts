import { Directive, inject, Injectable, OnDestroy, signal, TemplateRef } from '@angular/core';

/**
 * The screen's own action in the app's top bar on the phone (#114: Commands in a project space). The top bar belongs
 * to the shell and the screen below it to a page, which may not import each other; this holds the one template the
 * current screen offers, and the shell renders it next to its own trailing actions.
 */
@Injectable({ providedIn: 'root' })
export class TopBarActions {
  readonly template = signal<TemplateRef<unknown> | null>(null);
}

/**
 * Offers its template to the top bar while the host view lives; the template keeps the page's context (bindings,
 * click handlers). The last one created wins, and it is withdrawn on destroy.
 *
 * ```html
 * <ng-template tcTopBarAction><button tc-button size="sm" (click)="open()">Commands</button></ng-template>
 * ```
 */
@Directive({ selector: 'ng-template[tcTopBarAction]' })
export class TopBarAction implements OnDestroy {
  private readonly actions = inject(TopBarActions);
  private readonly template = inject<TemplateRef<unknown>>(TemplateRef);

  constructor() {
    this.actions.template.set(this.template);
  }

  ngOnDestroy(): void {
    if (this.actions.template() === this.template) {
      this.actions.template.set(null);
    }
  }
}
