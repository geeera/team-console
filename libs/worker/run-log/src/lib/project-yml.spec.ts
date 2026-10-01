import { runLogIssueOf } from './project-yml';

describe('runLogIssueOf (ptlib.project.run_log_issue)', () => {
  it.each([
    ['team:\n  plugin_ref: stable\n  run_log_issue: 22\n', 22],
    ['team:\n  run_log_issue: 7   # pinned by the owner\n', 7],
    ['run_log_issue:22', 22],
    ['team:\n  run_log_issue: "22"\n', 0],
    ['team:\n  run_log_issue: 22x\n', 0],
    ['team:\n  # run_log_issue: 22\n', 0],
    ['', 0],
  ])('%j → %i', (text, expected) => {
    expect(runLogIssueOf(text)).toBe(expected);
  });
});
