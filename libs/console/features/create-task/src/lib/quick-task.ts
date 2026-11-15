import { inject, Injectable, signal } from '@angular/core';
import { TranslocoService } from '@console/shared/i18n';
import { PersistedStateStore } from '@console/shared/persisted-state';
import { Sheet, Toaster } from '@console/shared/ui';
import type { ItemDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { QuickTaskAccess } from './quick-task-access';
import { QuickTaskSheet, type QuickTaskData } from './quick-task-sheet';

/**
 * Opens New task (#107): a sheet on the phone with Create in its head, a `task`-wide dialog on a Mac. The project is
 * the unsent draft's when there is one, else the one the owner is in (`slug`), else the last visited, else the first.
 * Closed with words still in it, the toast says the draft was kept.
 */
@Injectable({ providedIn: 'root' })
export class QuickTask {
  private readonly sheet = inject(Sheet);
  private readonly access = inject(QuickTaskAccess);
  private readonly drafts = inject(PersistedStateStore);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);

  /** The created item, or `null` when the sheet closed without one. */
  async open(slug: string | null): Promise<ItemDto | null> {
    const projects = this.access.trackerProjects();
    const isListed = (candidate: string | null | undefined): candidate is string =>
      projects.some((project) => project.slug === candidate);
    const draftSlug = this.drafts.quickTaskDraft()?.slug;
    const start = [draftSlug, slug, this.drafts.activeSlug(), projects[0]?.slug].find(isListed);
    if (start === undefined) {
      return null;
    }
    const into = signal('');
    const ref = this.sheet.open<ItemDto, QuickTaskData>(QuickTaskSheet, {
      title: this.transloco.translate('quickTask.title'),
      subtitle: into,
      headAction: true,
      width: 'task',
      autoFocus: '[data-testid="quick-task-title"]',
      data: { projects, slug: start, into },
    });
    const created = (await firstValueFrom(ref.closed)) ?? null;
    if (created === null && this.drafts.quickTaskDraft() !== undefined) {
      this.toaster.show(this.transloco.translate('quickTask.draft.kept'));
    }
    return created;
  }
}
