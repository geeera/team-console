"""Sprint numbers for the demo: plan vs shipped, cycle time, QA first-pass rate. Pure over fetched data."""
from __future__ import annotations

from datetime import datetime
from statistics import median
from typing import Dict, List, Optional

from . import tiers

WORK_KINDS = {"kind:feature", "kind:bug", "kind:chore", "kind:finding"}


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def cycle_days(closed_at: Optional[str], label_events: List[dict]) -> Optional[float]:
    """From the first move to status:in-progress until the issue closed."""
    starts = [e["created_at"] for e in label_events
              if e.get("event") == "labeled" and (e.get("label") or {}).get("name") == "status:in-progress"]
    if not closed_at or not starts:
        return None
    return round((_ts(closed_at) - _ts(min(starts))).total_seconds() / 86400, 1)


def qa_verdicts(reviews_by_pr: Dict[int, List[str]]) -> dict:
    """reviews_by_pr: PR number -> review bodies in order. First pass = approved with no earlier change request."""
    judged = first_pass = requested = 0
    for bodies in reviews_by_pr.values():
        verdicts = [b.strip().upper() for b in bodies if b and b.strip().upper().startswith("QA:")]
        if not verdicts:
            continue
        judged += 1
        changes = [v for v in verdicts if v.startswith("QA: CHANGES REQUESTED")]
        requested += len(changes)
        if verdicts[0].startswith("QA: APPROVED"):
            first_pass += 1
    return {
        "prs_reviewed": judged,
        "change_requests": requested,
        "first_pass_rate": round(first_pass / judged, 2) if judged else None,
    }


def sprint_summary(issues: List[dict], events: Dict[int, List[dict]], reviews_by_pr: Dict[int, List[str]]) -> dict:
    work = [i for i in issues if WORK_KINDS & set(i["labels"])]
    shipped = [i for i in work if i["state"] == "closed" and "status:done" in i["labels"]]
    cycles = [c for c in (cycle_days(i.get("closed_at"), events.get(i["number"], [])) for i in shipped) if c is not None]
    by_tier: Dict[str, dict] = {}
    for i in work:
        sized = any(l.startswith("tier:") for l in i["labels"])
        tier = tiers.declared(i["labels"]) if sized else "unsized"
        row = by_tier.setdefault(tier, {"planned": 0, "shipped": 0, "raised": 0})
        row["planned"] += 1
        row["shipped"] += i in shipped
        # Raised = built one tier higher than sized; a heavy or security-capped issue cannot be.
        if sized and "tier-up" in i["labels"]:
            built, _ = tiers.effective(i["labels"], burn=False, hotfix=False)
            without, _ = tiers.effective([l for l in i["labels"] if l != "tier-up"], burn=False, hotfix=False)
            row["raised"] += built != without
    return {
        "by_tier": by_tier,
        "planned": len(work),
        "shipped": len(shipped),
        "carried_over": sum(1 for i in work if i["state"] == "open"),
        "median_cycle_days": median(cycles) if cycles else None,
        "qa": qa_verdicts(reviews_by_pr),
    }
