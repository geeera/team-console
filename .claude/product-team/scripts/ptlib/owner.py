"""What the owner decides, what the team decides, and how questions to the owner are written
(reference/decision-policy.md). Pure helpers; `backlog` enforces them."""
from __future__ import annotations

import re
from typing import Optional

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


def reversed_by_owner(comments: list, owner_login: str) -> dict:
    """The owner's `/reject` written after the latest team decision on an issue, or {}."""
    decided_at = max((c.get("created_at") or "" for c in comments if DECISION_MARKER in (c.get("body") or "")), default="")
    if not decided_at:
        return {}
    from . import commands  # local import keeps owner.py free of the command grammar for its other callers
    return commands.latest(commands.parse(comments, owner_login), ["reject"], since=decided_at)


def decision_comment(text: str) -> str:
    return (f"{DECISION_MARKER}\n**Decided by the team** (not an owner decision under the decision policy; the "
            f"owner can reverse it with `/reject why`).\n\n{text.strip()}\n")
