import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DIALOG_DATA } from '@console/shared/ui';
import { CommandsPanel, type CommandsProject } from './commands-panel';

/** The Commands panel as the body of the phone's bottom sheet (`Sheet.open(CommandsSheet, { data: project })`). */
@Component({
  selector: 'tc-commands-sheet',
  imports: [CommandsPanel],
  template: `<tc-commands-panel mode="sheet" [project]="project" />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommandsSheet {
  protected readonly project = inject<CommandsProject>(DIALOG_DATA);
}
