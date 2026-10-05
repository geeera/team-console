// Kept apart from render-markdown.ts so importing these never pulls marked or DOMPurify into a bundle.

/** Sanitised HTML for `[innerHTML]` and the absolute links it contains, in document order. */
export interface RenderedMarkdown {
  readonly html: string;
  /** `https:` hrefs of the links left after sanitising (including rewritten images), deduplicated. */
  readonly links: readonly string[];
}

// GitHub caps an issue or comment body at 65,536 characters; anything longer is cut, never parsed whole.
export const MARKDOWN_MAX_LENGTH = 65_536;
