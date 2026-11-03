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
import unicodedata
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


_OPTION_SEPARATORS = set("·,;|")
_MARKER_WORDS = {"recommended", "рекомендую", "рекомендуем"}
_PARENTHESISED = re.compile(r"\(([^()]*)\)")
_CODE_SPAN = re.compile(r"`([^`]*)`")
_STARTS_WITH_COMMAND = re.compile(r"^/(?:approve|reject|no-go|go)(?![A-Za-z0-9_-])")
_RECOMMEND_WORD = re.compile(r"recommend|рекоменд")
_NEGATED = re.compile(
    r"(?:not|n['’]t|never|no)[\s-]*recommend|recommend[A-Za-z0-9_]*\s+against|не[\s-]*рекоменд|нет,?\s*рекоменд"
)


def _is_word_char(ch: str) -> bool:
    return unicodedata.category(ch)[0] in "LMN"


def _has_mixed_script_word(text: str) -> bool:
    word = ""
    for ch in text + " ":
        if _is_word_char(ch):
            word += ch
            continue
        names = [unicodedata.name(c, "") for c in word]
        if any(n.startswith("LATIN") for n in names) and any(n.startswith("CYRILLIC") for n in names):
            return True
        word = ""
    return False


def _options_of(text: str) -> list:
    pieces, depth, current = [], 0, ""
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if depth == 0 and ch in _OPTION_SEPARATORS:
            pieces.append(current)
            current = ""
        else:
            current += ch
    pieces.append(current)
    options: list = []
    for piece in pieces:
        if _COMMAND_WORD.search(piece) or not options:
            options.append(piece)
        else:
            options[-1] += " " + piece
    return options


def _markers_in(text: str) -> int:
    return sum(1 for inner in _PARENTHESISED.findall(text) if inner.split(",")[-1].strip() in _MARKER_WORDS)


def recommendation_of(ask: str | None) -> str | None:
    """Allowlist, fails closed (#233 SECURITY review): mirrors `recommendationOf` in owner-grammar's batch.ts."""
    if ask is None:
        return None
    text = unicodedata.normalize("NFKC", ask)
    if any(unicodedata.category(ch) == "Cf" for ch in text) or _has_mixed_script_word(text):
        return None
    text = _CODE_SPAN.sub(lambda m: m.group(1) if _STARTS_WITH_COMMAND.match(m.group(1).strip()) else " ", text)
    text = text.lower()
    if _NEGATED.search(text):
        return None
    if _markers_in(text) != 1 or len(_RECOMMEND_WORD.findall(text)) != 1:
        return None
    marked = [o for o in _options_of(text) if _markers_in(o) == 1]
    if len(marked) != 1:
        return None
    commands = set(_COMMAND_WORD.findall(marked[0]))
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
        # Round 2: only the plugin's "(…, recommended)" marker counts; disguises count for nothing.
        "/approve to ship it (not-recommended) · /reject why",
        "/approve to ship it (no recommendation) · /reject why",
        "/approve to ship it (unrecommended) · /reject why",
        "/approve to ship it (recommended against) · /reject why",
        "/approve to ship it (`recommended=false`) · /reject why",
        "/approve to ship it (nоt recommended) · /reject why",
        "/approve to ship it (not​ recommended) · /reject why",
        "/approve to ship it (not re­commended) · /reject why",
        "We recommend: /approve the plan",
    ],
    "ru": [
        "/approve — начинаем разработку по плану к демо 16 октября (рекомендую) · /reject что поменять",
        "/reject почему — оставить как есть (рекомендуем), /approve — переделать",
        "/approve купить домен за $12 в год · /reject причина",
        "/approve взять бесплатный план (Рекомендую) · /reject почему",
        "`/approve` — не рекомендую; `/reject почему` — оставить как есть",
        "/approve — нет, рекомендую отклонить · /reject почему",
        "/approve — сделать (не-рекомендуемо) · /reject почему",
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
