#!/usr/bin/env python3
"""The golden output of the read models (#35), produced by the product-team plugin itself.

  python3 libs/worker/read-models/fixtures/golden.py

For every `<name>.json` fixture next to this file, writes `<name>.expected.json` with what the vendored plugin
(`.claude/product-team/scripts`) computes from the same GitHub JSON: the inbox as `scripts/inbox` builds it
(`inbox.sections`, `brief.needs`, the scripts' own `slim`), `team.reviewer_logins` as `project.reviewer_logins_from_text`
reads it, and the sprint as `calendar.pick_current_sprint`, `backlog`'s `slim` and `metrics.sprint_summary` see it.
`recommendations.expected.json` holds questions as `owner.question_body` writes them, for every category and both
languages, with the batch rule's category and recommendation (#220).
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
import re
import sys
from collections import Counter
from datetime import date

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", ".claude", "product-team", "scripts"))
sys.path.insert(0, SCRIPTS)
from ptlib import brief, inbox, metrics, owner, project  # noqa: E402
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


# The batch rule's two readings (#220). The plugin has no function for them: it writes the `owner:<category>` label
# and the answer line (`backlog ask`, `owner.question_body`); these mirror `categoryOf` / `recommendationOf` in
# libs/shared/owner-grammar/src/lib/batch.ts and run over the plugin's own labels and ask lines.
_COMMAND_WORD = re.compile(r"(?<![A-Za-z0-9_/-])/(approve|reject|no-go|go)(?![A-Za-z0-9_-])")


def category_of(labels: list) -> str | None:
    found = [l[len("owner:"):] for l in labels if l.startswith("owner:") and l[len("owner:"):] in owner.CATEGORIES]
    return next((c for c in found if c != "scope"), found[0] if found else None)


_OPTION_SEPARATOR = re.compile(r"[·,;|]")
_RECOMMENDS = re.compile(r"recommend|рекоменд")
_NEGATED = re.compile(r"(?:not|n['’]t|never)\s+recommend|не\s*рекоменд")


def recommendation_of(ask: str | None) -> str | None:
    """Fails closed (#233 SECURITY review): the command of the one option that says it recommends, else None."""
    if ask is None:
        return None
    lower = ask.lower()
    if not _RECOMMENDS.search(lower) or _NEGATED.search(lower):
        return None
    options: list = []
    for piece in _OPTION_SEPARATOR.split(lower):
        if _COMMAND_WORD.search(piece) or not options:
            options.append(piece)
        else:
            options[-1] += "," + piece
    recommended = [o for o in options if _RECOMMENDS.search(o)]
    if len(recommended) != 1:
        return None
    commands = set(_COMMAND_WORD.findall(recommended[0]))
    return next(iter(commands)) if len(commands) == 1 else None


ASKS = {
    "en": [
        "/approve to use Cloudflare R2 (free, recommended) · /reject why to keep SeaweedFS",
        "`/approve` to ship the widget (recommended), `/reject why` to keep the list",
        "/reject why to keep the current flow (recommended) · /approve to switch",
        "/approve to add dark mode · /reject why",
        "/go to release 1.2.0 (recommended) · /no-go why",
        "/no-go to wait for the fix (Recommended) · /go",
        # #233 SECURITY review: the recommended option is not first, or the line negates a recommendation.
        "`/approve` to keep SeaweedFS · `/reject why` to move to R2 (recommended)",
        "`/approve` to add the export (not recommended) · `/reject why` to skip it",
        "We don't recommend this: `/approve` to ship anyway · `/reject why` to drop",
    ],
    "ru": [
        "/approve — начинаем разработку по плану к демо 16 октября (рекомендую) · /reject что поменять",
        "/reject почему — оставить как есть (рекомендуем), /approve — переделать",
        "/approve купить домен за $12 в год · /reject причина",
        "/approve взять бесплатный план (Рекомендую) · /reject почему",
        "`/approve` — не рекомендую; `/reject почему` — оставить как есть",
    ],
}


def recommendations() -> list:
    """Questions as `backlog create --kind question` / `backlog ask` writes them, for every category and language."""
    cases = []
    for language, asks in ASKS.items():
        for category in owner.CATEGORIES:
            for ask in asks:
                body = owner.question_body(ask, "Context for the owner.", category, language)
                labels = ["kind:question", f"owner:{category}"]
                read = owner.ask_of(body)
                cases.append({"language": language, "labels": labels, "body": body, "ask": read,
                              "category": category_of(labels), "recommendation": recommendation_of(read)})
    return cases


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
    labels = {i["number"]: i["labels"] for i in mine}
    batched = [dict(n, category=category_of(labels[n["number"]]), recommendation=recommendation_of(n["ask"]))
               for n in needs]
    return {
        "reviewerLogins": logins,
        "items": batched,
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
        if "openIssues" not in fixture:
            continue  # the artifacts and check-run fixtures have their own scripts
        expected = {
            "generatedBy": "python3 libs/worker/read-models/fixtures/golden.py",
            "inbox": inbox_of(fixture),
            "sprint": sprint_of(fixture),
        }
        with open(path[: -len(".json")] + ".expected.json", "w", encoding="utf-8") as f:
            json.dump(expected, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print(os.path.basename(path), len(expected["inbox"]["items"]), "inbox items")
    cases = recommendations()
    with open(os.path.join(HERE, "recommendations.expected.json"), "w", encoding="utf-8") as f:
        json.dump({"generatedBy": "python3 libs/worker/read-models/fixtures/golden.py", "cases": cases}, f,
                  ensure_ascii=False, indent=1)
        f.write("\n")
    print("recommendations.expected.json", len(cases), "questions")


if __name__ == "__main__":
    main()
