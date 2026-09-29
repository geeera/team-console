"""Which issue is the team's run log: the one pinned in project.yml, else the single labelled one the team opened.

The run log gates every scheduled run (pause, /resume, overlap). Taking "the newest issue labelled team:run-log"
would let anyone who can open and label an issue swap in a log of their own, so the choice is pinned or refused.
"""
from __future__ import annotations

from typing import Iterable, List, Optional

from . import gh, project, provenance, runstate

LABEL = "team:run-log"
RECOVERY = ("To recover: remove the team:run-log label from every issue the team or the owner did not open (a "
            "pause, /resume or failure streak recorded there is not carried over), or pin a run log the team or the "
            "owner opened as team.run_log_issue in .product-team/project.yml — a pinned issue anyone else opened is "
            "refused (reference/schedule-and-models.md).")


class AmbiguousLog(gh.GhError):
    pass


def choose(issues: List[dict], trusted: Iterable[str]) -> Optional[dict]:
    """The one labelled issue opened by a trusted login, None when there is none; refuses when there are several."""
    allowed = {t.lower() for t in trusted if t}
    candidates = sorted((i for i in issues if "pull_request" not in i
                         and provenance.author_of(i).lower() in allowed),
                        key=lambda i: (i.get("created_at") or "", i.get("number") or 0))
    if len(candidates) > 1:
        numbers = ", ".join(f"#{i['number']}" for i in candidates)
        raise AmbiguousLog(f"several run-log issues ({numbers}): set `team.run_log_issue` in "
                           ".product-team/project.yml to the one in use (reference/schedule-and-models.md)")
    return candidates[0] if candidates else None


def find(repo: str) -> Optional[dict]:
    """The run-log issue, or None only when no issue is labelled team:run-log at all (the team may create one)."""
    trusted = gh.team_logins(repo)
    pinned = project.run_log_issue()
    if pinned:
        issue = gh.api(f"repos/{repo}/issues/{pinned}")
        if provenance.author_of(issue).lower() not in {t.lower() for t in trusted}:
            raise AmbiguousLog(f"team.run_log_issue #{pinned} was opened by {provenance.author_of(issue) or 'nobody'}, "
                               f"not by the team or the owner, so it cannot be the run log. {RECOVERY}")
        return issue
    found = gh.api_list(f"repos/{repo}/issues?state=all&labels={LABEL}&per_page=100")
    chosen = choose(found, trusted)
    if chosen is None and any("pull_request" not in i for i in found):
        # Someone else's labelled issue is there: creating a second log beside it would fork the team's history.
        numbers = ", ".join(f"#{i['number']}" for i in found if "pull_request" not in i)
        raise AmbiguousLog(f"issues labelled {LABEL} ({numbers}) exist but none was opened by the team or the "
                           f"owner, and no second log is opened beside it. {RECOVERY} Or pin team.run_log_issue.")
    return chosen


def acted_on(repo: str) -> tuple:
    """([{issue, comment_id, run_id}], error): owner commands the team's runs recorded acting on (`--acted`)."""
    try:
        log = find(repo)
        if not log:
            return [], ""
        comments = gh.api_list(f"repos/{repo}/issues/{log['number']}/comments?per_page=100")
        history = provenance.fetch(repo, log["number"])
        if history.get("error"):
            return [], f"run log unreadable: {history['error']}"
        team = gh.team_logins(repo) | {provenance.author_of(log)}
        runs = runstate.parse_runs(provenance.screen(comments, team, history)[0])
    except gh.GhError as exc:
        return [], str(exc)
    return [{"issue": issue, "comment_id": cid, "run_id": r["id"], "at": r["at"]}
            for r in runs for issue, cid in r["acted"]], ""
