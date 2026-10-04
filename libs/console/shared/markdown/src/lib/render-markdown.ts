import DOMPurify, { type Config } from 'dompurify';
import { Marked } from 'marked';

/** Sanitised HTML for `[innerHTML]` and the absolute links it contains, in document order. */
export interface RenderedMarkdown {
  readonly html: string;
  /** `https:` hrefs of the links left after sanitising (including rewritten images), deduplicated. */
  readonly links: readonly string[];
}

// GitHub caps an issue or comment body at 65,536 characters; anything longer is cut, never parsed whole.
export const MARKDOWN_MAX_LENGTH = 65_536;

const ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'details',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'kbd',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
];

// No `style`, `class`, `id` or `name`: untrusted text must not reach the app's styles or clobber DOM names.
const ALLOWED_ATTR = ['href', 'title', 'alt', 'src', 'colspan', 'rowspan', 'align', 'start'];

/**
 * DOMPurify profile from the architect note on #20. The allow-lists above are the real gate; the forbid-lists
 * repeat the dangerous cases so a future widening of the allow-lists cannot bring them back by accident.
 */
const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'input', 'button', 'style', 'svg', 'math', 'script'],
  FORBID_ATTR: ['style', 'class', 'id', 'name', 'srcset', 'formaction', 'xlink:href'],
  ALLOWED_URI_REGEXP: /^(?:https:|mailto:|#)/i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  KEEP_CONTENT: true,
  RETURN_DOM_FRAGMENT: true as const,
} satisfies Config;

const markdown = new Marked({ gfm: true, breaks: false, async: false });

/** The protocols a sanitised link may keep; checked again here, independent of DOMPurify's own URI check. */
function safeHrefOf(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const href = value.trim();
  if (href.startsWith('#')) {
    return href;
  }
  if (!URL.canParse(href)) {
    return null;
  }
  const url = new URL(href);
  return url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
}

/** An image becomes a link to it named by its alt text or file name (decision 13; `img-src 'self'` blocks it anyway). */
function imageLabelOf(image: Element, href: string | null): string {
  const alt = image.getAttribute('alt')?.trim() ?? '';
  if (alt !== '') {
    return alt;
  }
  if (href !== null && !href.startsWith('#') && !href.startsWith('mailto:')) {
    const name = new URL(href).pathname.split('/').filter(Boolean).at(-1);
    if (name !== undefined) {
      return decodeURIComponentSafe(name);
    }
  }
  return 'image';
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error: unknown) {
    if (error instanceof URIError) {
      return value;
    }
    throw error;
  }
}

function rewriteImages(root: DocumentFragment): void {
  const document = root.ownerDocument;
  for (const image of Array.from(root.querySelectorAll('img'))) {
    const href = safeHrefOf(image.getAttribute('src'));
    const label = imageLabelOf(image, href);
    if (href !== null && href.startsWith('https:')) {
      const link = document.createElement('a');
      link.setAttribute('href', href);
      link.textContent = label;
      image.replaceWith(link);
    } else {
      image.replaceWith(document.createTextNode(label));
    }
  }
}

function hardenLinks(root: DocumentFragment): string[] {
  const links: string[] = [];
  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    const href = safeHrefOf(anchor.getAttribute('href'));
    if (href === null) {
      anchor.removeAttribute('href');
      continue;
    }
    anchor.setAttribute('href', href);
    if (href.startsWith('#')) {
      continue;
    }
    anchor.setAttribute('rel', 'noopener noreferrer');
    anchor.setAttribute('target', '_blank');
    if (href.startsWith('https:') && !links.includes(href)) {
      links.push(href);
    }
  }
  return links;
}

/**
 * Untrusted GitHub markdown to HTML that cannot run script (#20): `marked` parses, DOMPurify sanitises against the
 * profile above, then images become links and every link is re-checked and opens in a new tab without a referrer.
 * HTML comments (the team's `<!-- pt-… -->` markers) are dropped.
 */
export function renderMarkdown(text: string): RenderedMarkdown {
  const source = text.length > MARKDOWN_MAX_LENGTH ? text.slice(0, MARKDOWN_MAX_LENGTH) : text;
  const parsed = markdown.parse(source, { async: false });
  const fragment = DOMPurify.sanitize(parsed, PURIFY_CONFIG);
  rewriteImages(fragment);
  const links = hardenLinks(fragment);
  const container = fragment.ownerDocument.createElement('div');
  container.append(fragment);
  return { html: container.innerHTML, links };
}
