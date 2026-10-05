#!/usr/bin/env python3
"""Golden fixtures for @worker/run-log, produced by the vendored product-team plugin itself.

Run from the repository root after every `vendor` update of `.claude/product-team`:

    python3 libs/worker/run-log/fixtures/generate.py

run-state.json — `runlog`'s own reading of a run log in REST-only mode (the only mode a Worker has): the team's
                 comments screened by `runlog.team_comments`, then `runstate.parse_runs`, `effective_state`,
                 `decide` and `active_owner_pause`, over hand-written logs.
commands.json  — the comment bodies the real `runlog pause --record-file F --reason R` and `runlog resume` post,
                 with GitHub stubbed out and the clock frozen.

Both record the plugin version and a SHA-256 of every plugin file they depend on; the TypeScript spec fails with
"regenerate the fixtures" when the vendored plugin no longer matches.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[4]
PLUGIN = ROOT / ".claude" / "product-team"
SCRIPTS = PLUGIN / "scripts"
OUT = Path(__file__).resolve().parent
SOURCES = (
    "scripts/runlog",
    "scripts/ptlib/runstate.py",
    "scripts/ptlib/provenance.py",
)

sys.path.insert(0, str(SCRIPTS))
from ptlib import gh, runstate  # noqa: E402


def load_runlog():
    loader = importlib.machinery.SourceFileLoader("pt_runlog", str(SCRIPTS / "runlog"))
    spec = importlib.util.spec_from_loader("pt_runlog", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


RUNLOG = load_runlog()
REPO = "geeera/fixture-product"
TEAM = "geeera"
NOW = datetime(2026, 10, 1, 12, 0, 0, tzinfo=timezone.utc)
LOG = {"number": 22, "user": {"login": TEAM}, "labels": [{"name": "team:run-log"}],
       "html_url": f"https://github.com/{REPO}/issues/22"}

gh.app_mode = lambda: False


def ago(minutes: float) -> str:
    return (NOW - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


_ids = iter(range(1000, 100000))


def comment(body: str, minutes: float, author: str = TEAM, edited_after: float = 0) -> dict:
    created = ago(minutes)
    updated = ago(minutes - edited_after) if edited_after else created
    return {"id": next(_ids), "body": body, "created_at": created, "updated_at": updated, "user": {"login": author}}


def entry(run_id: str, slot: str, state: str, minutes: float, **kw) -> dict:
    return comment(f"<!-- pt-run id={run_id} slot={slot} state={state} -->\n**{slot}** {state}", minutes, **kw)


def pause_record(record: str, minutes: float, **kw) -> dict:
    return comment(f"<!-- pt-paused -->\n<!-- pt-owner-pause {record} -->\n**Development paused by the owner**", minutes, **kw)


def resume(minutes: float, **kw) -> dict:
    return comment("<!-- pt-owner-resume -->\n**Development resumed**", minutes, **kw)


SCENARIOS = {
    "empty": [],
    "dev in progress": [entry("r1-slot-dev", "slot-dev", "started", 30)],
    "dev finished": [entry("r1-slot-dev", "slot-dev", "started", 90), entry("r1-slot-dev", "slot-dev", "finished", 20)],
    "dev started just under 3h": [entry("r1-slot-dev", "slot-dev", "started", 179)],
    "dev started exactly 3h": [entry("r1-slot-dev", "slot-dev", "started", 180)],
    "dev started over 3h counts as failed": [entry("r1-slot-dev", "slot-dev", "started", 240)],
    "three failures pause": [
        entry("a", "slot-pm", "started", 600), entry("a", "slot-pm", "failed", 590),
        entry("b", "slot-dev", "started", 500), entry("b", "slot-dev", "failed", 490),
        entry("c", "slot-qa", "started", 400), entry("c", "slot-qa", "failed", 390),
    ],
    "an unknown run breaks the streak": [
        entry("a", "slot-pm", "started", 600), entry("a", "slot-pm", "failed", 590),
        entry("b", "slot-dev", "started", 500), entry("b", "slot-dev", "finished", 490, edited_after=5),
        entry("c", "slot-qa", "started", 400), entry("c", "slot-qa", "failed", 390),
        entry("d", "slot-qa", "started", 300), entry("d", "slot-qa", "failed", 290),
    ],
    "an edited finish keeps a started run unknown": [
        entry("a", "slot-dev", "started", 60), entry("a", "slot-dev", "finished", 30, edited_after=1),
    ],
    "an edited start never creates a run": [entry("a", "slot-dev", "started", 30, edited_after=2)],
    "an outsider's entry is ignored": [entry("x", "slot-dev", "started", 10, author="outsider")],
    "an outsider cannot finish a team run": [
        entry("a", "slot-dev", "started", 60), entry("a", "slot-dev", "finished", 30, author="outsider"),
    ],
    "author case is ignored": [entry("a", "slot-qa", "started", 10, author="GEEERA")],
    "metrics and acted": [
        entry("a", "slot-dev", "started", 100),
        comment('<!-- pt-run id=a slot=slot-dev state=finished -->\n<!-- pt-metrics {"merged": 1, "minutes": 40} -->\n'
                '<!-- pt-acted [[72, 5931722592], [5, "x"]] -->\n**slot-dev** finished', 60),
    ],
    "a broken metrics block": [
        entry("a", "slot-dev", "started", 100),
        comment("<!-- pt-run id=a slot=slot-dev state=finished -->\n<!-- pt-metrics {broken} -->", 60),
    ],
    "the slot comes from the first entry": [
        entry("a", "slot-dev", "started", 100), entry("a", "slot-qa", "finished", 60),
    ],
    "owner pause active": [pause_record('{"reason": "\\u043e\\u0442\\u043f\\u0443\\u0441\\u043a", "source": "team-console"}', 50)],
    "owner pause resumed": [pause_record('{"reason": "x", "source": "team-console"}', 50), resume(20)],
    "paused again after a resume": [
        pause_record('{"reason": "one"}', 90), resume(60), pause_record('{"reason": "two", "routines": []}', 30),
    ],
    "an edited pause record is no record": [pause_record('{"reason": "x"}', 50, edited_after=3)],
    "a broken pause record": [pause_record("{not json}", 50)],
    "a pause record by an outsider": [pause_record('{"reason": "x"}', 50, author="outsider")],
    "a pause record across lines": [comment('<!-- pt-owner-pause {"reason":\n"two lines"} -->', 40)],
    "same second resume and pause": [pause_record('{"reason": "x"}', 30), resume(30)],
    "several slots": [
        entry("p", "slot-pm", "started", 400), entry("p", "slot-pm", "finished", 380),
        entry("d", "slot-dev", "started", 100),
        entry("q", "slot-qa", "started", 20),
    ],
}

SLOTS = ("slot-pm", "slot-dev", "slot-qa")


def run_view(run: dict) -> dict:
    return {
        "id": run["id"], "slot": run["slot"], "state": run["state"], "at": run["at"],
        "commentId": run["comment_id"], "metrics": run["metrics"], "acted": run["acted"],
        "trusted": run["trusted"], "finishedAt": run["finished_at"],
        "effective": runstate.effective_state(run, NOW),
    }


def scenario_case(name: str, comments: list) -> dict:
    history = {"error": "fixtures: REST-only, like a Worker"}
    team, untrusted = RUNLOG.team_comments(LOG, comments, history)
    runs = runstate.parse_runs(team, untrusted)
    pause = runstate.active_owner_pause(team)
    decisions = {}
    for slot in SLOTS:
        for paused in (False, True):
            decisions[f"{slot} {'paused' if paused else 'running'}"] = runstate.decide(runs, slot, NOW, paused)
    reset = ago(450)
    decisions["slot-dev after reset"] = runstate.decide(runs, "slot-dev", NOW, False, reset)
    return {
        "name": name,
        "issueAuthor": TEAM,
        "now": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "resetAt": reset,
        "comments": comments,
        "runs": [run_view(r) for r in runs],
        "ownerPause": None if pause is None else {"record": {k: v for k, v in pause.items() if k != "paused_at"},
                                                  "pausedAt": pause["paused_at"]},
        "decisions": decisions,
    }


class Frozen(datetime):
    moment = datetime(2026, 10, 1, 13, 52, 37, 123456, tzinfo=timezone.utc)

    @classmethod
    def now(cls, tz=None):
        return cls.moment


def run_with_stubs(fn, args) -> list:
    posted = []

    def api(path, method="GET", fields=None, auth=None):
        posted.append({"method": method, "path": path, "fields": fields})
        return {"id": 1, "html_url": "https://github.com/x"}

    saved = (gh.api, RUNLOG.datetime, RUNLOG.log_issue, RUNLOG.load)
    gh.api = api
    RUNLOG.datetime = Frozen
    RUNLOG.log_issue = lambda repo: dict(LOG, labels=[{"name": "team:run-log"}, {"name": "team:paused"}])
    RUNLOG.load = lambda repo: (RUNLOG.log_issue(repo), [], {"error": "fixtures"})
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            fn(REPO, args)
    finally:
        gh.api, RUNLOG.datetime, RUNLOG.log_issue, RUNLOG.load = saved
    return posted


REASONS = [
    "", "отпуск", "back Monday", 'quote " and \\ backslash', "tab\there", "line one\nline two", "emoji \U0001f600",
    "<b>not html</b>", " nbsp", " separator", "control \x01 char", "del \x7f char", "  spaced  ",
    "/resume", "**bold**", "ünïcödé — dash",
]


def command_cases() -> dict:
    pauses = []
    for reason in REASONS:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump({"source": "team-console"}, f)
            record_file = f.name
        try:
            posted = run_with_stubs(RUNLOG.cmd_pause, argparse.Namespace(record_file=record_file, reason=reason))
        finally:
            os.unlink(record_file)
        pauses.append({"reason": reason, "requests": posted})
    resumed = run_with_stubs(RUNLOG.cmd_resume, argparse.Namespace())
    return {"now": Frozen.moment.isoformat(), "pause": pauses, "resume": resumed}


def plugin_header() -> dict:
    manifest = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    return {
        "version": manifest["version"],
        "sources": {path: hashlib.sha256((PLUGIN / path).read_bytes()).hexdigest() for path in SOURCES},
    }


def write(name: str, data: dict) -> None:
    (OUT / name).write_text(json.dumps(data, indent=1, ensure_ascii=True) + "\n", encoding="utf-8")


def main() -> None:
    header = plugin_header()
    cases = [scenario_case(name, comments) for name, comments in SCENARIOS.items()]
    write("run-state.json", {"plugin": header, "cases": cases})
    write("commands.json", {"plugin": header, **command_cases()})
    print(f"plugin {header['version']}: {len(cases)} run-log cases, commands.json written", file=sys.stderr)


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
