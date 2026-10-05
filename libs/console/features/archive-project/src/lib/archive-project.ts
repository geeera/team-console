import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { TranslocoService } from '@console/shared/i18n';
import { Sheet, Toaster } from '@console/shared/ui';
import type { ProjectDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export function archiveUrlOf(slug: string): string {
  return `${PROJECTS_URL}/${encodeURIComponent(slug)}/archive`;
}

/**
 * Archiving a project from Settings (#24): the confirmation (focus on Cancel, Esc cancels, "Archiving…" while the
 * request runs, an inline error when it fails), then the project leaves the list, the switcher and Needs you, and a
 * `role=status` toast says so. GitHub is not touched. Resolves `true` once archived; where focus goes next is the
 * caller's, because only the caller knows its rows.
 */
@Injectable({ providedIn: 'root' })
export class ArchiveProject {
  private readonly http = inject(HttpClient);
  private readonly sheet = inject(Sheet);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);
  private readonly projects = inject(ProjectsStore);

  async archive(project: Pick<ProjectDto, 'slug' | 'displayName'>): Promise<boolean> {
    const name = project.displayName;
    const archived = await this.sheet.confirm({
      title: this.transloco.translate('settings.archive.title', { name }),
      message: this.transloco.translate('settings.archive.body'),
      note: this.transloco.translate('settings.archive.note'),
      confirmLabel: this.transloco.translate('settings.archive.confirm'),
      busyLabel: this.transloco.translate('settings.archive.busy'),
      errorMessage: this.transloco.translate('settings.archive.error'),
      tone: 'danger',
      action: () => this.request(project.slug),
    });
    if (archived) {
      this.projects.remove(project.slug);
      this.toaster.show(this.transloco.translate('settings.archive.toast', { name }));
    }
    return archived;
  }

  private async request(slug: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post(archiveUrlOf(slug), {}));
    } catch (error: unknown) {
      // Already archived elsewhere (archived projects are 404 on every project route): the outcome stands.
      if (error instanceof HttpErrorResponse && error.status === 404) {
        return;
      }
      throw error;
    }
  }
}
