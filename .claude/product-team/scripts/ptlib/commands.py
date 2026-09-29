"""Owner commands in issue comments: /approve, /reject <why>, /go, /no-go <why>, /resume, /override <why>."""
from __future__ import annotations

import re
from typing import Iterable, List

COMMANDS = ("approve", "reject", "go", "no-go", "resume", "override")
_LINE = re.compile(r"^\s*/(approve|reject|go|no-go|resume|override)\b[ \t:]*(.*)$", re.IGNORECASE | re.MULTILINE)


def parse(comments: Iterable[dict], owner: str) -> List[dict]:
    """Commands from the owner only, oldest first. Anyone else's commands are ignored by design."""
    found = []
    for c in comments:
        author = (c.get("user") or c.get("author") or {}).get("login", "")
        if author.lower() != owner.lower():
            continue
        for m in _LINE.finditer(c.get("body") or ""):
            found.append(
                {
                    "command": m.group(1).lower(),
                    "text": m.group(2).strip(),
                    "at": c.get("created_at") or c.get("createdAt"),
                    "comment_id": c.get("id"),
                    "url": c.get("html_url") or c.get("url"),
                }
            )
    found.sort(key=lambda f: f["at"] or "")
    return found


def latest(commands: List[dict], names: Iterable[str], since: str = "") -> dict:
    """Most recent command among `names` created after `since` (ISO timestamp), or {}."""
    wanted = set(names)
    hits = [c for c in commands if c["command"] in wanted and (c["at"] or "") > since]
    return hits[-1] if hits else {}
