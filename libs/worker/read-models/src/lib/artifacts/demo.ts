import type { ArtifactDto } from '@shared/contracts';
import type { IssueRecord } from '../github-records';
import { byRecentIssue, issueArtifactOf } from './common';

export const DEMO_LABEL = 'team:demo';

/**
 * Sprint demos: the `team:demo` issues, open and closed. The stage URL lives in the team's comments on the issue,
 * and the console links to github.com only, so the artifact is the issue itself; its body is never rendered here.
 */
export function demoArtifactsOf(issues: readonly IssueRecord[]): ArtifactDto[] {
  return issues
    .filter((issue) => issue.labels.includes(DEMO_LABEL))
    .slice()
    .sort(byRecentIssue)
    .flatMap((issue) => issueArtifactOf('demo', issue) ?? []);
}
