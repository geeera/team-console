import { Routes } from '@angular/router';
import { DEFAULT_SPACE_SECTION, SPACE_SECTIONS } from '@console/entities/project';
import { ChatPlaceholderPage } from './chat-placeholder.page';
import { QuestionsSectionPage } from './questions-section.page';
import { SectionPlaceholderPage } from './section-placeholder.page';

/**
 * The children of `/p/:slug`. The space root redirects to the default section; the shell has already
 * sent a returning visitor to the project's last path, so this only sees a bare `/p/{slug}`.
 */
export const projectSpaceChildRoutes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: DEFAULT_SPACE_SECTION },
  ...SPACE_SECTIONS.map((section) => ({
    path: section,
    component:
      section === 'questions'
        ? QuestionsSectionPage
        : section === 'chat'
          ? ChatPlaceholderPage
          : SectionPlaceholderPage,
    data: { section },
  })),
];
