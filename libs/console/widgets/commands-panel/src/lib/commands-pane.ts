import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@console/shared/i18n';
import { CommandsPanel, type CommandsProject } from './commands-panel';

/**
 * The Commands panel as the right-hand pane of a wide screen (#114 in the space, #222 on All projects): beside the
 * page and non-modal, so the page stays usable while it is open. The page decides when it shows and where focus
 * goes when it closes.
 */
@Component({
  selector: 'tc-commands-pane',
  imports: [CommandsPanel],
  template: `<tc-commands-panel mode="pane" [project]="project()" (closed)="closed.emit()" />`,
  styleUrl: './commands-pane.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-commands-pane', role: 'complementary', '[attr.aria-label]': 'label()' },
})
export class CommandsPane {
  private readonly transloco = inject(TranslocoService);
  private readonly lang = toSignal(this.transloco.langChanges$, { initialValue: this.transloco.getActiveLang() });

  readonly project = input.required<CommandsProject>();
  readonly closed = output<void>();

  protected readonly label = computed(() => {
    this.lang();
    return this.transloco.translate('commands.title', { name: this.project().name });
  });
}
