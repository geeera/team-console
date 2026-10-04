"""Summarise a commit's CI: check runs and legacy commit statuses → pass / fail / pending."""
from __future__ import annotations

from typing import List, Optional

FAILED = {"failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"}


def summarise(check_runs: List[dict], statuses: List[dict], suites: Optional[List[dict]] = None) -> dict:
    """check_runs from the default `filter=latest` endpoint (re-runs already collapsed by GitHub).

    Runs are not de-duplicated by name: two workflows may each have a job called `build`, and either failing
    must fail the PR.
    """
    failing, pending, passing = [], [], []
    for run in sorted(check_runs, key=lambda r: r.get("name", "")):
        name = run.get("name", "?")
        if run.get("status") != "completed":
            pending.append(name)
        elif run.get("conclusion") in FAILED:
            failing.append(name)
        else:
            passing.append(name)  # success, neutral, skipped
    # A GitHub Actions suite that has not finished (e.g. a job waiting on `needs:` without a check run yet)
    # means CI is not done. Suites of other apps are ignored: some sit "queued" forever without ever running.
    for suite in suites or []:
        if (suite.get("app") or {}).get("slug") == "github-actions" and suite.get("status") != "completed":
            pending.append(f"suite {suite.get('id')}")
    seen = set()
    for st in statuses:  # newest first from the API; the first per context wins
        ctx = st.get("context", "?")
        if ctx in seen:
            continue
        seen.add(ctx)
        {"success": passing, "pending": pending}.get(st.get("state"), failing).append(ctx)
    state = "fail" if failing else "pending" if pending or not (passing or failing) else "pass"
    return {"state": state, "failing": failing, "pending": pending, "passing": passing}
