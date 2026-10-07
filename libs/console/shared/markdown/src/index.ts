// The renderer itself (marked + DOMPurify) is loaded on demand by `Markdown`; nothing here imports it statically.
export { MARKDOWN_MAX_LENGTH } from './lib/rendered-markdown';
export type { RenderedMarkdown } from './lib/rendered-markdown';
export { Markdown } from './lib/markdown';
export { markdownToPlainText } from '@shared/plain-text';
