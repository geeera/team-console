"""What the owner decides, what the team decides, and how questions to the owner are written
(reference/decision-policy.md). Pure helpers; `backlog` enforces them."""
from __future__ import annotations

import re
from typing import Iterable, Optional

# The only reasons to ask the owner. Everything else the team decides and records.
CATEGORIES = {
    "money": "spending anything: a paid plan, an upgrade, a domain, a paid API",
    "scope": "what the product does or stops doing; adding or dropping a feature",
    "release": "release go / no-go, or overriding a release blocker",
    "access": "accounts, secrets and permissions only the owner can create or grant",
    "legal": "terms, privacy, licences, anything with legal exposure",
    "design": "approving a design or a visual direction",
}
ASK_MARKER = "<!-- pt-ask -->"
DECISION_MARKER = "<!-- pt-team-decision -->"
HANDLED = re.compile(r"^<!-- pt-reversal-handled id=(\d+) -->$", re.MULTILINE)
_ASK = re.compile(r"^\*\*(?:Your answer|Ваш ответ|Твой ответ):\*\*\s*(.+)$", re.MULTILINE)

LABELS = {"en": "Your answer", "ru": "Твой ответ"}


def question_body(ask: str, body: str, category: str, language: str = "en") -> str:
    if category not in CATEGORIES:
        raise ValueError(f"not an owner decision: {category!r}. The owner decides only {', '.join(CATEGORIES)}; "
                         "decide anything else as a team and record it with `backlog decide`.")
    ask = " ".join(ask.split())
    if not ask or ("/approve" not in ask and "/reject" not in ask and "/go" not in ask and "/no-go" not in ask):
        raise ValueError("the ask must say which command answers it, e.g. "
                         "'/approve to use X (recommended), /reject why to keep Y'")
    label = LABELS.get(language, LABELS["en"])
    return f"**{label}:** {ask}\n{ASK_MARKER}\n\n{body.strip()}\n"


def ask_of(body: str) -> Optional[str]:
    m = _ASK.search(body or "")
    return m.group(1).strip() if m else None


def is_decision(body: str) -> bool:
    """A decision comment starts with the marker (`decision_comment`); a status reason, an answer or any other
    comment that merely quotes it is not one."""
    return (body or "").startswith(DECISION_MARKER)


def team_decisions(comments: list, team_logins: Iterable[str], history: Optional[dict]) -> list:
    """The team's decision comments on an issue, oldest first: by the team's own logins, nobody else edited them.

    A marker anyone else posts or edits in would otherwise move the decision date past an owner's `/reject`.
    """
    from . import provenance  # local import: provenance talks to GitHub, the pure helpers above do not
    decisions, _ = provenance.screen(comments, team_logins, history)
    return sorted((c for c in decisions if is_decision(c.get("body") or "")), key=lambda c: c.get("created_at") or "")


def team_decided_at(comments: list, team_logins: Iterable[str], history: Optional[dict]) -> str:
    """When the team last recorded a decision on an issue, or ""."""
    decisions = team_decisions(comments, team_logins, history)
    return decisions[-1].get("created_at") or "" if decisions else ""


def handled_reversals(comments: list, team_logins: Iterable[str], history: Optional[dict]) -> list:
    """Owner `/reject`s the team answered with a new decision (`backlog decide --handles-reversal`)."""
    return [{"reject_comment_id": int(m.group(1)), "decided_at": c.get("created_at"),
             "decision_url": c.get("html_url")}
            for c in team_decisions(comments, team_logins, history)
            for m in [HANDLED.search(c.get("body") or "")] if m]


def reversed_by_owner(comments: list, owner_login: str, history: Optional[dict], team_logins: Iterable[str]) -> dict:
    """The owner's `/reject` written after the latest team decision on an issue, or {}.

    history: provenance.fetch of the issue; team_logins: who writes the team's decisions (gh.team_logins).
    """
    decided_at = team_decided_at(comments, set(team_logins) | {owner_login}, history)
    if not decided_at:
        return {}
    from . import commands  # local import keeps owner.py free of the command grammar for its other callers
    return commands.latest(commands.parse(comments, owner_login, history), ["reject"], since=decided_at)


def decision_comment(text: str, handles_reversal: Optional[str] = None, reversal_url: str = "") -> str:
    handled = ""
    if handles_reversal:
        handled = (f"\n<!-- pt-reversal-handled id={handles_reversal} -->\n"
                   f"**Answers your /reject:** {reversal_url or f'comment {handles_reversal}'}\n")
    return (f"{DECISION_MARKER}{handled}\n**Decided by the team** (not an owner decision under the decision policy; "
            f"the owner can reverse it with `/reject why`).\n\n{text.strip()}\n")
