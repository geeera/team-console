import type { StoryObj } from '@storybook/angular';

/**
 * Every primitive shows the same three extra states, so the file for each one stays about
 * its variants: the dark theme, reduced motion and the phone width. Story-level `globals`
 * pin the toolbar for that story.
 */
export const darkTheme = { globals: { theme: 'dark' } } satisfies Partial<StoryObj>;
export const reducedMotion = { globals: { motion: 'reduce' } } satisfies Partial<StoryObj>;
export const phoneViewport = {
  globals: { viewport: { value: 'iphone', isRotated: false } },
} satisfies Partial<StoryObj>;
