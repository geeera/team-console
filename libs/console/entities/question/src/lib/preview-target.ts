import { frameSrcOf } from '@console/shared/ui';

// Links to the issue tracker itself are context (the PR, an earlier issue), never the design or demo to look at.
const SOURCE_HOSTS = /(?:^|\.)(?:github\.com|githubusercontent\.com)$/;

/**
 * The page a design or demo card previews, from the links of its sanitised body: the first one the project allows
 * framing, else the first one off GitHub (shown as "can't be shown here" with a link), else none.
 */
export function previewTargetOf(
  links: readonly string[],
  embedOrigins: readonly string[],
  ownOrigin: string,
): string | null {
  const embeddable = links.find((link) => frameSrcOf(link, embedOrigins, ownOrigin) !== null);
  if (embeddable !== undefined) {
    return embeddable;
  }
  return links.find((link) => URL.canParse(link) && !SOURCE_HOSTS.test(new URL(link).hostname)) ?? null;
}
