"""Run-log state machine: overlap guard and the 3-failures-in-a-row pause.

The log is append-only: a run is a `started` comment and, later, a `finished` or `failed` comment with the same
run id (`runlog finish` never edits the started one). `parse_runs` merges the trusted entries of one id; the
latest wins. An entry the caller could not trust (edited, and the edit history unavailable or showing an
outsider — see provenance) supplies nothing: it never creates a run and never changes a run's slot, start or
state. It only flags a trusted run of the same id it postdates (`trusted: False`), whose effective state is then
`unknown` — not a failure, and a streak-breaker, so an edited entry can never pause the team for good — unless
the run is still `started`: then the overlap guard holds, because nothing an edited entry says ends a run.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Dict, Iterable, List, Optional

MARKER = re.compile(r"<!-- pt-run id=(\S+) slot=(\S+) state=(\S+) -->")
PAUSE_MARKER = "<!-- pt-paused -->"
OWNER_PAUSE = re.compile(r"<!-- pt-owner-pause (\{.*?\}) -->", re.DOTALL)
OWNER_RESUME = "<!-- pt-owner-resume -->"
METRICS = re.compile(r"<!-- pt-metrics (\{.*?\}) -->")
ACTED = re.compile(r"<!-- pt-acted (\[.*?\]) -->")
FAILURE_LIMIT = 3
OVERLAP_WINDOW = timedelta(hours=3)
UNKNOWN = "unknown"
FINAL = ("finished", "failed")


def _entries(comments: Iterable[dict]) -> List[dict]:
    found = []
    for c in comments:
        m = MARKER.search(c.get("body") or "")
        if m:
            body = c.get("body") or ""
            found.append({"id": m.group(1), "slot": m.group(2), "state": m.group(3), "at": c.get("created_at"),
                          "comment_id": c.get("id"), "metrics": _metrics_of(body), "acted": _acted_of(body)})
    return sorted(found, key=lambda e: e["at"] or "")


def parse_runs(comments: List[dict], untrusted: Iterable[dict] = ()) -> List[dict]:
    """Runs, oldest first, one per run id, from trusted entries only: `at` and `slot` from the first, `state`,
    `comment_id`, `metrics`, `acted` and `finished_at` from the latest. untrusted: team comments screened out
    (provenance.partition); one that postdates a run's latest trusted entry sets `trusted: False` (see above)."""
    runs: Dict[str, dict] = {}
    for e in _entries(comments):
        run = runs.get(e["id"])
        finished_at = e["at"] if e["state"] in FINAL else None
        if run is None:
            runs[e["id"]] = dict(e, trusted=True, finished_at=finished_at)
        else:
            run.update(state=e["state"], comment_id=e["comment_id"], metrics=e["metrics"], acted=e["acted"],
                       finished_at=finished_at, last_at=e["at"])
    for e in _entries(untrusted):
        run = runs.get(e["id"])
        if run is not None and (e["at"] or "") >= (run.get("last_at") or run["at"] or ""):
            run["trusted"] = False
    for run in runs.values():
        run.pop("last_at", None)
    return sorted(runs.values(), key=lambda r: r["at"] or "")


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def effective_state(run: dict, now: datetime) -> str:
    """A `started` run older than the overlap window died (usually on the usage limit): count it as failed. A run
    an untrusted entry postdates is `unknown` once it ended; while `started` it still counts as in progress."""
    if run["state"] == "started":
        return "failed" if now - _ts(run["at"]) >= OVERLAP_WINDOW else "started"
    return run["state"] if run.get("trusted", True) else UNKNOWN


def decide(runs: List[dict], slot: str, now: datetime, paused: bool, reset_at: str = "") -> dict:
    """reset_at: the owner's last /resume; failures before it no longer count."""
    if paused:
        return {"decision": "paused", "reason": "run log is paused; owner must comment /resume"}
    for r in reversed(runs):
        if r["slot"] == slot and effective_state(r, now) == "started":
            return {"decision": "overlap", "reason": f"run {r['id']} of slot {slot} is still in progress"}
    finished = [effective_state(r, now) for r in runs if (r["at"] or "") > reset_at]
    # An `unknown` run stays in the tail: a streak is only three failures the log can vouch for, in a row.
    tail = [s for s in finished if s != "started"][-FAILURE_LIMIT:]
    if len(tail) == FAILURE_LIMIT and all(s == "failed" for s in tail):
        return {"decision": "pause", "reason": f"last {FAILURE_LIMIT} runs failed"}
    return {"decision": "proceed", "reason": ""}


def resumed_after_pause(pause_at: Optional[str], owner_commands: List[dict]) -> bool:
    if not pause_at:
        return False
    return any(c["command"] == "resume" and (c["at"] or "") > pause_at for c in owner_commands)


def _metrics_of(body: str) -> dict:
    # The run log is a public comment thread: a malformed block must not stop every future run.
    m = METRICS.search(body)
    if not m:
        return {}
    try:
        value = json.loads(m.group(1))
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def parse_acted(pairs: Iterable[str]) -> List[List[int]]:
    """`--acted ISSUE:COMMENT_ID` values → [[issue, comment_id], …]; anything but two numbers is refused."""
    out = []
    for pair in pairs:
        issue, sep, comment = pair.partition(":")
        if not sep or not issue.strip().isdigit() or not comment.strip().isdigit():
            raise ValueError(f"--acted must look like ISSUE:COMMENT_ID (the owner command's comment id), got {pair!r}")
        out.append([int(issue), int(comment)])
    return out


def acted_marker(pairs: List[List[int]]) -> str:
    """The owner commands a run acted on, so a command deleted afterwards can be noticed (`backlog answers`)."""
    return f"<!-- pt-acted {json.dumps(pairs)} -->" if pairs else ""


def _acted_of(body: str) -> List[List[int]]:
    m = ACTED.search(body)
    if not m:
        return []
    try:
        value = json.loads(m.group(1))
    except ValueError:
        return []
    if not isinstance(value, list):
        return []
    return [p for p in value if isinstance(p, list) and len(p) == 2 and all(isinstance(x, int) for x in p)]


def started_at(run_id: str) -> datetime:
    """Run ids start with the UTC start time, e.g. 20260927T201300Z-slot-dev."""
    return datetime.strptime(run_id.split("-", 1)[0], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)


def parse_metrics(pairs: Iterable[str]) -> Dict[str, object]:
    out: Dict[str, object] = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep or not key.strip():
            raise ValueError(f"metric must look like key=value, got {pair!r}")
        value = value.strip()
        if "-->" in pair or "<!--" in pair:
            raise ValueError(f"metric must not contain HTML comment markers: {pair!r}")
        out[key.strip()] = int(value) if value.lstrip("-").isdigit() else value
    return out


def metrics_marker(metrics: Dict[str, object]) -> str:
    return f"<!-- pt-metrics {json.dumps(metrics, sort_keys=True)} -->"


def stats(runs: List[dict], now: datetime, since: datetime) -> Dict[str, dict]:
    """Per slot: runs, failures (dangling counted), unknown (untrusted entries), median minutes, summed metrics."""
    per_slot: Dict[str, dict] = {}
    for r in runs:
        if not r["at"] or _ts(r["at"]) < since:
            continue
        slot = per_slot.setdefault(r["slot"], {"runs": 0, "failed": 0, "unknown": 0, "minutes": [], "totals": {}})
        slot["runs"] += 1
        state = effective_state(r, now)
        if state == "failed":
            slot["failed"] += 1
        elif state == UNKNOWN:
            slot["unknown"] += 1
        minutes = r["metrics"].get("minutes")
        if isinstance(minutes, int):
            slot["minutes"].append(minutes)
        for key, value in r["metrics"].items():
            if key != "minutes" and isinstance(value, int):
                slot["totals"][key] = slot["totals"].get(key, 0) + value
    for slot in per_slot.values():
        mins = slot.pop("minutes")
        slot["median_minutes"] = median(mins) if mins else None
    return per_slot


def owner_pause_marker(record: Dict[str, object]) -> str:
    """A pause the owner asked for, with what was switched off so resume can switch exactly that back on."""
    return f"<!-- pt-owner-pause {json.dumps(record, sort_keys=True)} -->"


def active_owner_pause(comments: List[dict]) -> Optional[dict]:
    """The latest owner pause record that has not been resumed since, or None."""
    latest, latest_at, resumed_at = None, "", ""
    for c in comments:
        body, at = c.get("body") or "", c.get("created_at") or ""
        m = OWNER_PAUSE.search(body)
        if m and at >= latest_at:
            try:
                latest, latest_at = json.loads(m.group(1)), at
            except ValueError:
                continue
        if OWNER_RESUME in body and at > resumed_at:
            resumed_at = at
    if latest is None or resumed_at > latest_at:
        return None
    return dict(latest, paused_at=latest_at)
