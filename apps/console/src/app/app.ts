import { ChangeDetectionStrategy, Component } from '@angular/core';
import { AppShell } from '@console/widgets/app-shell';

@Component({
  imports: [AppShell],
  selector: 'tc-root',
  template: '<tc-app-shell />',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
