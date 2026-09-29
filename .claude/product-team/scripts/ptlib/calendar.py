"""Slot calendar: which mode a run is in (normal / burn / freeze), per reference/schedule-and-models.md."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from typing import Optional

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    raise SystemExit("Python 3.9+ is required (zoneinfo)")

KYIV = ZoneInfo("Europe/Kyiv")

# Burn window: Friday 23:00 → Sunday 19:00 local (quota resets Sunday 20:00; keep an hour of margin).
BURN_START = (4, 23)  # (weekday Mon=0, hour)
BURN_END = (6, 19)

DEFAULT_CAPS = {
    "normal": {"dev_tasks": 2, "parallel_devs": 2},
    "burn": {"dev_tasks": 5, "parallel_devs": 3},
    "freeze": {"dev_tasks": 0, "parallel_devs": 1},
}


@dataclass
class SlotContext:
    local_time: str
    weekday: str
    is_burn: bool
    is_freeze: bool
    is_cut_day: bool
    mode: str
    sprint: Optional[str]
    demo_date: Optional[str]
    caps: dict

    def to_dict(self) -> dict:
        return asdict(self)


def is_burn(now: datetime) -> bool:
    minutes = now.weekday() * 24 * 60 + now.hour * 60 + now.minute
    start = BURN_START[0] * 24 * 60 + BURN_START[1] * 60
    end = BURN_END[0] * 24 * 60 + BURN_END[1] * 60
    return start <= minutes < end


def freeze_window(demo: date, freeze_days: int) -> tuple:
    """Stage is cut `freeze_days` before the demo; the freeze lasts through demo day."""
    return demo - timedelta(days=freeze_days), demo


def compute(
    now: datetime,
    sprint: Optional[str] = None,
    demo: Optional[date] = None,
    freeze_days: int = 2,
    caps_override: Optional[dict] = None,
) -> SlotContext:
    local = now.astimezone(KYIV)
    today = local.date()
    burn = is_burn(local)
    freeze = cut_day = False
    if demo is not None:
        start, end = freeze_window(demo, freeze_days)
        freeze = start <= today <= end
        cut_day = today == start
    # Freeze beats burn: a burn run during the freeze does regression and fixes, just with burn models.
    mode = "freeze" if freeze else ("burn" if burn else "normal")
    caps = dict(DEFAULT_CAPS[mode])
    if caps_override and mode in caps_override:
        caps.update(caps_override[mode])
    return SlotContext(
        local_time=local.isoformat(timespec="minutes"),
        weekday=local.strftime("%A"),
        is_burn=burn,
        is_freeze=freeze,
        is_cut_day=cut_day,
        mode=mode,
        sprint=sprint,
        demo_date=demo.isoformat() if demo else None,
        caps=caps,
    )


def pick_current_sprint(milestones: list, today: date) -> Optional[dict]:
    """The open milestone with the earliest due date that is today or later."""
    candidates = []
    for m in milestones:
        due = m.get("due_on")
        if m.get("state") != "open" or not due:
            continue
        # GitHub stores due_on as midnight UTC of the chosen day (sometimes 07:00/08:00Z); the date part is the day.
        due_day = date.fromisoformat(due[:10])
        if due_day >= today:
            candidates.append((due_day, m))
    if not candidates:
        return None
    return min(candidates, key=lambda c: c[0])[1]
