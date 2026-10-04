"""What the owner hears when they open the team chat: what changed since last time, and what needs them."""
from __future__ import annotations

import re
from typing import Dict, List, Optional

from datetime import datetime, timezone

from . import inbox, owner, runstate

BRIEFED = re.compile(r"<!-- pt-briefed at=(\S+) -->")
DONE_MARKER = "<!-- pt-owner-done -->"
# What each kind of item can be answered with. Action items ("create the account") are reported done, never approved.
ANSWERS = {
    "question": ("approve", "reject"),
    "design": ("approve", "reject"),
    "release": ("go", "no-go", "override"),
    "owner": ("done",),
    "local": ("done",),
}
ANSWERABLE = tuple(sorted({a for answers in ANSWERS.values() for a in answers}))


def briefed_at(comments: List[dict]) -> Optional[str]:
    stamps = [m.group(1) for c in comments for m in [BRIEFED.search(c.get("body") or "")] if m]
    return max(stamps) if stamps else None


def briefed_marker(at: str) -> str:
    return f"<!-- pt-briefed at={at} -->\nThe owner was last briefed in the team chat at {at}."


def needs(open_issues: List[dict]) -> List[dict]:
    """Everything waiting for the owner, in the inbox's order, with the answer line when there is one."""
    order = {key: i for i, key in enumerate(inbox.ORDER)}
    found = []
    for issue in open_issues:
        key = inbox.classify(issue)
        if key:
            found.append({"section": key, "number": issue["number"], "title": issue["title"], "url": issue["url"],
                          "ask": issue.get("ask") or owner.ask_of(issue.get("body") or "")})
    return sorted(found, key=lambda n: (order.get(n["section"], 99), n["number"]))


def one_line(text: str) -> str:
    """Owner text is written as one line: a newline could otherwise start a second command."""
    return " ".join((text or "").split())


def answer_comment(command: str, text: str, owner_words: str, section: str) -> str:
    """The owner's answer, given in the team chat, written as what the team reads for that kind of item."""
    allowed = ANSWERS.get(section)
    if not allowed:
        raise ValueError("this issue is not waiting for the owner (not in the owner's inbox)")
    if command not in allowed:
        raise ValueError(f"a {section} item is answered with {' / '.join(allowed)}, not {command}")
    text, words = one_line(text), one_line(owner_words)
    if not words:
        raise ValueError("quote what the owner said (--owner-said), so the answer can be traced to their words")
    if command in ("reject", "no-go", "override") and not text:
        raise ValueError(f"{command} needs the owner's reason")
    said = f"_Answered by the owner in the team chat: «{words}»_"
    if command == "done":
        return f"{DONE_MARKER}\n**The owner reports this done.** {text}\n\n{said}\n".replace("  ", " ")
    return f"/{command} {text}".rstrip() + f"\n\n{said}\n"


def summary(since: Optional[str], closed: List[dict], merged: List[dict], decided: List[dict],
            runs: List[dict], open_issues: List[dict], sprint: Optional[dict], paused: bool,
            now: Optional[datetime] = None, generated_at: str = "") -> Dict[str, object]:
    """decided: issues with `decided_at` (the time of the team's decision comment)."""
    def after(ts: Optional[str]) -> bool:
        return bool(ts) and (since is None or ts > since)

    done = [i for i in closed if after(i.get("closed_at")) and "status:done" in i.get("labels", [])]
    now = now or datetime.now(timezone.utc)
    recent_runs = [r for r in runs if after(r.get("at"))]
    return {
        "since": since,
        "generated_at": generated_at,
        "paused": paused,
        "sprint": sprint,
        "shipped": [{"number": i["number"], "title": i["title"], "url": i["url"]} for i in done],
        "merged_prs": [{"number": p["number"], "title": p["title"], "url": p["url"]} for p in merged if after(p.get("merged_at"))],
        "team_decisions": [{"number": d["number"], "title": d["title"], "url": d["url"]} for d in decided if after(d.get("decided_at"))],
        # The owner's /rejects the team answered with a new decision: told explicitly, never silently absorbed.
        "answered_rejects": [dict(h, number=d["number"], title=d["title"]) for d in decided
                             for h in d.get("handled_reversals", []) if after(h.get("decided_at"))],
        # A run left at `started` died (usually on the usage limit): it counts as failed.
        "runs": {"total": len(recent_runs),
                 "failed": sum(1 for r in recent_runs if runstate.effective_state(r, now) == "failed")},
        "needs_you": needs(open_issues),
    }
