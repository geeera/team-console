import '@angular/cdk/overlay-prebuilt.css';
import '@angular/cdk/a11y-prebuilt.css';
import '../src/tokens/tokens.css';
import '../src/styles/base.css';
import '../src/styles/overlay.css';

import { DOCUMENT } from '@angular/common';
import { inject, provideEnvironmentInitializer, provideZonelessChangeDetection } from '@angular/core';
import {
  CONSOLE_LANGS,
  DEFAULT_LANG,
  isConsoleLang,
  provideConsoleI18n,
  TranslocoService,
} from '@console/shared/i18n';
import { applicationConfig, type Preview } from '@storybook/angular';

const THEME_ATTRIBUTE = 'data-theme';
const MOTION_ATTRIBUTE = 'data-motion';
const LANG_ATTRIBUTE = 'data-lang';

/**
 * The toolbar writes the language onto <html>; the Angular app inside the preview may be
 * bootstrapped earlier or later than that, so it watches the attribute rather than the globals.
 */
function syncLangFromToolbar(): void {
  const document = inject(DOCUMENT);
  const transloco = inject(TranslocoService);
  const apply = (): void => {
    const lang = document.documentElement.getAttribute(LANG_ATTRIBUTE);
    if (isConsoleLang(lang) && lang !== transloco.getActiveLang()) {
      transloco.setActiveLang(lang);
    }
  };
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [LANG_ATTRIBUTE],
  });
  apply();
}

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Paper Desk theme',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        items: [
          { value: 'auto', title: 'System' },
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
    motion: {
      description: 'Motion preference',
      toolbar: {
        title: 'Motion',
        icon: 'play',
        items: [
          { value: 'system', title: 'Motion: system' },
          { value: 'reduce', title: 'Motion: reduced' },
        ],
        dynamicTitle: true,
      },
    },
    lang: {
      description: 'Interface language',
      toolbar: {
        title: 'Language',
        icon: 'globe',
        items: CONSOLE_LANGS.map((lang) => ({ value: lang, title: lang.toUpperCase() })),
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light', motion: 'system', lang: DEFAULT_LANG },
  decorators: [
    (story, { globals }) => {
      const root = document.documentElement;
      const theme = globals['theme'];
      const motion = globals['motion'];
      const lang = globals['lang'];
      if (theme === 'light' || theme === 'dark') {
        root.setAttribute(THEME_ATTRIBUTE, theme);
      } else {
        root.removeAttribute(THEME_ATTRIBUTE);
      }
      if (motion === 'reduce') {
        root.setAttribute(MOTION_ATTRIBUTE, 'reduce');
      } else {
        root.removeAttribute(MOTION_ATTRIBUTE);
      }
      root.setAttribute(LANG_ATTRIBUTE, isConsoleLang(lang) ? lang : DEFAULT_LANG);
      return story();
    },
    applicationConfig({
      providers: [
        provideZonelessChangeDetection(),
        provideConsoleI18n(),
        provideEnvironmentInitializer(syncLangFromToolbar),
      ],
    }),
  ],
  parameters: {
    a11y: { test: 'error' },
    controls: { expanded: true },
    backgrounds: { disable: true },
    viewport: {
      options: {
        iphone: { name: 'iPhone (390 px)', styles: { width: '390px', height: '844px' } },
        mac: { name: 'Mac window (1180 px)', styles: { width: '1180px', height: '760px' } },
      },
    },
  },
};

export default preview;
