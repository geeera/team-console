import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { NeedsYouCounts, ProjectsStore } from '@console/entities/project';
import { ProjectSwitcher } from '@console/features/project-switcher';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Chip, DialogRef, Icon, List, ListRow, StateBlock } from '@console/shared/ui';

/** The phone's "Projects" sheet: Needs you, the switcher, then Add project and Settings at the bottom (#24). */
@Component({
  selector: 'tc-projects-sheet',
  imports: [Button, Chip, Icon, List, ListRow, ProjectSwitcher, StateBlock, TranslocoPipe],
  templateUrl: './projects-sheet.html',
  styleUrl: './projects-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectsSheet {
  private readonly router = inject(Router);
  private readonly ref = inject(DialogRef);

  protected readonly projects = inject(ProjectsStore);
  protected readonly needsYou = inject(NeedsYouCounts);

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
