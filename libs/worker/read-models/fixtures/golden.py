#!/usr/bin/env python3
"""The golden output of the read models (#35), produced by the product-team plugin itself.

  python3 libs/worker/read-models/fixtures/golden.py

For every `<name>.json` fixture next to this file, writes `<name>.expected.json` with what the vendored plugin
(`.claude/product-team/scripts`) computes from the same GitHub JSON: the inbox as `scripts/inbox` builds it
(`inbox.sections`, `brief.needs`, the scripts' own `slim`), `team.reviewer_logins` as `project.reviewer_logins_from_text`
reads it, and the sprint as `calendar.pick_current_sprint`, `backlog`'s `slim` and `metrics.sprint_summary` see it.
Needs no credentials and no network. Re-run it after vendoring a new plugin version; a diff in the output is a
change the TypeScript port must follow.

Two inputs the scripts take from the live session are fixed by the fixture instead: "today" (the fixture's `today`)
and the setup item, which the scripts show while the agents may act as the owner — here, as in the console,
while `team.reviewer_logins` is empty.
"""
from __future__ import annotations

import glob
import importlib.machinery
import importlib.util
import json
import os
import sys
from collections import Counter
from datetime import date

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", ".claude", "product-team", "scripts"))
sys.path.insert(0, SCRIPTS)
from ptlib import brief, inbox, metrics, project  # noqa: E402
from ptlib.calendar import pick_current_sprint  # noqa: E402


def script(name: str):
    """A plugin script without a .py suffix, loaded as a module (its `main` is not run)."""
    loader = importlib.machinery.SourceFileLoader(f"pt_{name.replace('-', '_')}", os.path.join(SCRIPTS, name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


INBOX, BACKLOG = script("inbox"), script("backlog")


def item(entry: dict) -> dict:
    # An empty answer line is "" in the inbox's slim and None in brief.needs; both show no answer line.
    return dict({k: entry.get(k) for k in ("section", "number", "title", "url")}, ask=entry.get("ask") or None)


def inbox_of(fixture: dict) -> dict:
    # scripts/inbox build(): open issues without pull requests, slimmed; paused = any open team:paused issue.
    issues = [INBOX.slim(i) for i in fixture["openIssues"] if "pull_request" not in i]
    paused = next((i for i in issues if "team:paused" in i["labels"]), None)
    mine = [i for i in issues if "team:inbox" not in i["labels"] and "team:run-log" not in i["labels"]]
    logins = project.reviewer_logins_from_text(fixture["projectYml"])
    checklist = "" if logins else f"https://github.com/{fixture['repo']}/blob/HEAD/.product-team/owner-checklist.md"
    groups = inbox.sections(mine, paused["url"] if paused else "", checklist)
    rendered = [dict(item(entry), section=key) for key in inbox.ORDER if key not in ("setup", "paused")
                for entry in groups[key]]
    needs = [item(n) for n in brief.needs(mine)]
    if rendered != needs:
        raise SystemExit(f"{fixture['repo']}: inbox.sections and brief.needs disagree; the plugin changed shape")
    return {
        "reviewerLogins": logins,
        "items": needs,
        "setup": bool(groups["setup"]),
        "setupUrl": checklist or None,
        "paused": bool(groups["paused"]),
        "pausedUrl": paused["url"] if paused else None,
    }


def sprint_of(fixture: dict) -> dict:
    milestone = pick_current_sprint(fixture["milestones"], date.fromisoformat(fixture["today"]))
    if milestone is None:
        return {"milestone": None}
    raw = [i for i in fixture["milestoneIssues"].get(str(milestone["number"]), []) if "pull_request" not in i]
    listed = [BACKLOG.slim(i) for i in raw]
    # sprint-metrics' own projection of an issue.
    issues = [{"number": i["number"], "state": i["state"], "closed_at": i.get("closed_at"),
               "labels": [l["name"] for l in i["labels"]]} for i in raw]
    summary = metrics.sprint_summary(issues, {}, {})
    return {
        "milestone": {"number": milestone["number"], "title": milestone["title"], "dueOn": milestone["due_on"][:10]},
        "issues": sorted(({"number": i["number"], "status": i["status"], "kind": i["kind"], "state": i["state"]}
                          for i in listed), key=lambda i: i["number"]),
        "byStatus": dict(Counter(i["status"] or "none" for i in listed)),
        "planned": summary["planned"],
        "shipped": summary["shipped"],
        "carriedOver": summary["carried_over"],
        "byTier": summary["by_tier"],
    }


def main() -> None:
    for path in sorted(glob.glob(os.path.join(HERE, "*.json"))):
        if path.endswith(".expected.json"):
            continue
        with open(path, encoding="utf-8") as f:
            fixture = json.load(f)
        expected = {
            "generatedBy": "python3 libs/worker/read-models/fixtures/golden.py",
            "inbox": inbox_of(fixture),
            "sprint": sprint_of(fixture),
        }
        with open(path[: -len(".json")] + ".expected.json", "w", encoding="utf-8") as f:
            json.dump(expected, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print(os.path.basename(path), len(expected["inbox"]["items"]), "inbox items")


if __name__ == "__main__":
    main()
