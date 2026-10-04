import { Type } from '@angular/core';
import { Routes } from '@angular/router';
import { DEFAULT_SPACE_SECTION, SPACE_SECTIONS, SpaceSection } from '@console/entities/project';
import { ArtifactsSectionPage } from './artifacts-section.page';
import { BoardSectionPage } from './board-section.page';
import { ChatPlaceholderPage } from './chat-placeholder.page';
import { DemoSectionPage } from './demo-section.page';
import { QuestionsSectionPage } from './questions-section.page';

// A new section fails to compile until it has a screen here.
const SECTION_PAGES: Readonly<Record<SpaceSection, Type<unknown>>> = {
  questions: QuestionsSectionPage,
  chat: ChatPlaceholderPage,
  board: BoardSectionPage,
  artifacts: ArtifactsSectionPage,
  demo: DemoSectionPage,
};

/**
 * The children of `/p/:slug`. The space root redirects to the default section; the shell has already
 * sent a returning visitor to the project's last path, so this only sees a bare `/p/{slug}`.
 */
export const projectSpaceChildRoutes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: DEFAULT_SPACE_SECTION },
  ...SPACE_SECTIONS.map((section) => ({
    path: section,
    component: SECTION_PAGES[section],
    data: { section },
  })),
];
