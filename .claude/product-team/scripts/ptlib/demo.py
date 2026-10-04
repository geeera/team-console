"""Demo page data: filling the template and reading back the owner's decisions."""
from __future__ import annotations

import json
import re
from typing import List, Optional

from . import provenance

START, END = "/*PT-DEMO-DATA-START*/", "/*PT-DEMO-DATA-END*/"
REQUIRED = ("product", "repo", "sprint", "demo_date", "demo_issue", "release", "shipped", "proposals", "findings")
_BLOCK = re.compile(r"^\s*/demo-decisions\s*\n```(?:json)?\s*\n(.*?)\n```", re.MULTILINE | re.DOTALL)


def fill(template: str, data: dict) -> str:
    missing = [k for k in REQUIRED if k not in data]
    if missing:
        raise ValueError(f"demo data is missing keys: {', '.join(missing)}")
    if START not in template or END not in template:
        raise ValueError("template has no demo data markers")
    # `</` inside a <script> would end it early; JSON allows the escaped form.
    payload = json.dumps(dict(data, example=False), ensure_ascii=False, indent=2).replace("</", "<\\/")
    head, rest = template.split(START, 1)
    _, tail = rest.split(END, 1)
    return head + START + payload + END + tail


def decisions_from_comments(comments: List[dict], owner: str, history: Optional[dict]) -> Optional[dict]:
    """The owner's latest /demo-decisions block, or None. Blocks from anyone else, or in an owner comment someone
    else edited (history: provenance.fetch of the demo issue), are ignored."""
    latest = None
    trusted, _ = provenance.screen(comments, [owner], history)
    for c in sorted(trusted, key=lambda c: c.get("created_at") or ""):
        for m in _BLOCK.finditer(c.get("body") or ""):
            try:
                parsed = json.loads(m.group(1))
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and isinstance(parsed.get("decisions"), dict):
                latest = dict(parsed, source=c.get("html_url"))
    return latest


def normalise_db_rows(rows: List[dict]) -> dict:
    """ArtifactData `list` rows of the `decisions` collection → the same shape as the comment block."""
    out = {}
    for row in rows:
        body = row.get("data") if isinstance(row.get("data"), dict) else row
        item = body.get("item") or row.get("id")
        if item:
            out[item] = {"decision": body.get("decision"), "comment": body.get("comment") or ""}
    return {"decisions": out, "source": "artifact-db"}
