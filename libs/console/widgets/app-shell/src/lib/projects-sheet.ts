import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ADD_PROJECT_URL, NeedsYouCounts, ProjectsStore } from '@console/entities/project';
import { ProjectSwitcher } from '@console/features/project-switcher';
import { LocalNumberPipe, TranslocoPipe } from '@console/shared/i18n';
import { Button, Chip, DialogRef, Icon, List, ListRow, SheetFooter, StateBlock } from '@console/shared/ui';

/** The phone's "Projects" sheet: Needs you, the switcher, then Add project (All projects, #194) and Settings. */
@Component({
  selector: 'tc-projects-sheet',
  imports: [
    Button,
    Chip,
    Icon,
    List,
    ListRow,
    LocalNumberPipe,
    ProjectSwitcher,
    SheetFooter,
    StateBlock,
    TranslocoPipe,
  ],
  templateUrl: './projects-sheet.html',
  styleUrl: './projects-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectsSheet {
  private readonly router = inject(Router);
  private readonly ref = inject(DialogRef);

  protected readonly projects = inject(ProjectsStore);
  protected readonly needsYou = inject(NeedsYouCounts);
  protected readonly addProjectUrl = ADD_PROJECT_URL;

  protected close(): void {
    this.ref.close();
  }

  protected async go(url: string): Promise<void> {
    this.ref.close();
    await this.router.navigateByUrl(url);
  }

  protected retry(): void {
    void this.projects.load();
  }
}
