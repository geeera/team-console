/**
 * `ptlib.project.run_log_issue`: the run-log issue pinned in `.product-team/project.yml` (`team.run_log_issue`),
 * read with the plugin's own line pattern rather than a YAML parser, so the console and the team pick the same
 * issue for the same file. `0` when not pinned.
 */
export function runLogIssueOf(projectYml: string): number {
  const match = /^\s*run_log_issue:\s*(\d+)\s*(?:#.*)?$/m.exec(projectYml);
  const value = match?.[1] === undefined ? 0 : Number(match[1]);
  return Number.isSafeInteger(value) ? value : 0;
}
