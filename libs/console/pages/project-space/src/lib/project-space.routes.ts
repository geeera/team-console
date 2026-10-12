import { Type } from '@angular/core';
import { Route, Routes } from '@angular/router';
import { CHAT_TAB_ENABLED } from '@shared/contracts';
import { DEFAULT_SPACE_SECTION, SPACE_SECTIONS, SpaceSection } from '@console/entities/project';
import { ArtifactsSectionPage } from './artifacts-section.page';
import { BoardSectionPage } from './board-section.page';
import { ChatPlaceholderPage } from './chat-placeholder.page';
import { DemoSectionPage } from './demo-section.page';
import { QuestionsSectionPage } from './questions-section.page';

// A new section fails to compile until it has a screen here, even while it is not routed (see `chat` below).
const SECTION_PAGES: Readonly<Record<SpaceSection, Type<unknown>>> = {
  questions: QuestionsSectionPage,
  chat: ChatPlaceholderPage,
  board: BoardSectionPage,
  artifacts: ArtifactsSectionPage,
  demo: DemoSectionPage,
};

/**
 * One section's child route: a real screen, or — for `chat` while `CHAT_TAB_ENABLED` is off (#203, brought
 * back by #17) — a redirect to the default section, so a typed URL, an old bookmark or the `pm-reply` push
 * never shows the placeholder or an error screen.
 */
function routeOf(section: SpaceSection): Route {
  if (section === 'chat' && !CHAT_TAB_ENABLED) {
    return { path: section, pathMatch: 'full', redirectTo: DEFAULT_SPACE_SECTION };
  }
  return { path: section, component: SECTION_PAGES[section], data: { section } };
}

/**
 * The children of `/p/:slug`. The space root redirects to the default section; the shell has already
 * sent a returning visitor to the project's last path, so this only sees a bare `/p/{slug}`.
 */
export const projectSpaceChildRoutes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: DEFAULT_SPACE_SECTION },
  ...SPACE_SECTIONS.map(routeOf),
];
