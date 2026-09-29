"""Development tiers: the architect sizes each issue (`tier:*`), this module turns that into the agent — and
therefore the pinned model — that builds it, with the guard rails applied in code."""
from __future__ import annotations

from typing import Iterable, Tuple

ORDER = ("light", "standard", "heavy")
AGENTS = {"light": "fullstack-dev-light", "standard": "fullstack-dev", "heavy": "fullstack-dev-heavy"}
MODELS = {"light": "claude-sonnet-5", "standard": "claude-opus-5-5", "heavy": "claude-fable-5-1"}


def declared(labels: Iterable[str]) -> str:
    """The architect's tier; `standard` when none (or several) is set."""
    found = [l[len("tier:"):] for l in labels if l.startswith("tier:") and l[len("tier:"):] in ORDER]
    return found[0] if len(found) == 1 else "standard"


def effective(labels: Iterable[str], *, burn: bool, hotfix: bool) -> Tuple[str, list]:
    """(tier, reasons it differs from the declared one)."""
    labels = set(labels)
    tier = declared(labels)
    why = []
    rank = ORDER.index(tier)
    if "tier-up" in labels and rank < len(ORDER) - 1:
        rank += 1
        why.append("raised after two failed review rounds")
    if (burn or hotfix) and rank == 0:
        rank = 1
        why.append("burn window: quota to spare" if burn else "hotfix: no light work in production")
    tier = ORDER[rank]
    # Fable's extra cyber safeguards cause refusals on security work (SPEC decision 13).
    if tier == "heavy" and "security" in labels:
        tier = "standard"
        why.append("security work never runs on Fable")
    return tier, why
