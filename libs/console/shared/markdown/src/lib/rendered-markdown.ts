// Kept apart from render-markdown.ts so importing these never pulls marked or DOMPurify into a bundle.

/** Sanitised HTML for `[innerHTML]` and the absolute links it contains, in document order. */
export interface RenderedMarkdown {
  readonly html: string;
  /** `https:` hrefs of the links left after sanitising (including rewritten images), deduplicated. */
  readonly links: readonly string[];
}

export { MARKDOWN_MAX_LENGTH } from '@shared/plain-text';
