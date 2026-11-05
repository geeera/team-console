import type { ItemSummaryDto } from '@shared/contracts';

/** A registered project as Find needs it: where its tasks live. */
export interface FindProject {
  readonly slug: string;
  readonly name: string;
  /** `owner/name` on GitHub. */
  readonly repo: string;
  readonly keyPrefix: string | null;
  readonly isOnConsole: boolean;
}

/**
 * What the owner typed (#409 §2.4): a number (`142`, `#142`, `TC-142`), a pasted GitHub issue link
 * (`https://github.com/{owner}/{repo}/issues/142`) — numbers are kept at the cutover, so #142 there is TC-142 here —
 * or words from a title.
 */
export type FindQuery =
  | { readonly kind: 'empty' }
  | { readonly kind: 'number'; readonly number: number }
  /** A link or key of another project the console knows: open it there, or on GitHub if it has not moved. */
  | { readonly kind: 'elsewhere'; readonly project: FindProject; readonly number: number }
  /** A GitHub issue link of a repository no project here holds. */
  | { readonly kind: 'unknown-link' }
  | { readonly kind: 'words'; readonly words: readonly string[] };

const NUMBER = /^#?([1-9][0-9]{0,8})$/;
const KEY = /^([A-Za-z]{2,5})-([1-9][0-9]{0,8})$/;
const ISSUE_PATH = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/issues\/([1-9][0-9]{0,8})\/?$/;

function issueLinkOf(text: string): { readonly repo: string; readonly number: number } | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // Not a URL: the text is a number, a key or words.
    return null;
  }
  if (url.protocol !== 'https:' || (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')) {
    return null;
  }
  const match = ISSUE_PATH.exec(url.pathname);
  return match === null ? null : { repo: `${match[1] ?? ''}/${match[2] ?? ''}`, number: Number(match[3]) };
}

export function findQueryOf(text: string, here: FindProject, projects: readonly FindProject[]): FindQuery {
  const query = text.trim();
  if (query === '') {
    return { kind: 'empty' };
  }
  const number = NUMBER.exec(query);
  if (number !== null) {
    return { kind: 'number', number: Number(number[1]) };
  }
  const key = KEY.exec(query);
  if (key !== null) {
    const prefix = (key[1] ?? '').toUpperCase();
    const n = Number(key[2]);
    if (prefix === here.keyPrefix) {
      return { kind: 'number', number: n };
    }
    const other = projects.find((project) => project.keyPrefix === prefix);
    if (other !== undefined) {
      return { kind: 'elsewhere', project: other, number: n };
    }
  }
  const link = issueLinkOf(query);
  if (link !== null) {
    const repo = link.repo.toLowerCase();
    if (here.repo.toLowerCase() === repo) {
      return { kind: 'number', number: link.number };
    }
    const other = projects.find((project) => project.repo.toLowerCase() === repo);
    return other === undefined
      ? { kind: 'unknown-link' }
      : { kind: 'elsewhere', project: other, number: link.number };
  }
  const words = query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  return { kind: 'words', words };
}

/** Title words, every one present (case-insensitive); open first, then by number, newest first. */
export function matchesOf(items: readonly ItemSummaryDto[], words: readonly string[]): ItemSummaryDto[] {
  return items
    .filter((item) => {
      const title = item.title.toLocaleLowerCase();
      return words.every((word) => title.includes(word));
    })
    .sort((a, b) => (a.state === b.state ? b.number - a.number : a.state === 'open' ? -1 : 1));
}

/** The issue's page on GitHub for a project still on GitHub; only github.com, only an integer number. */
export function githubIssueUrl(project: FindProject, number: number): string | null {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(project.repo)) {
    return null;
  }
  return `https://github.com/${project.repo}/issues/${String(number)}`;
}
