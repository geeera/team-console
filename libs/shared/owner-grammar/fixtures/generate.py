#!/usr/bin/env python3
"""Golden fixtures for @shared/owner-grammar, produced by the vendored product-team plugin itself.

Run from the repository root after every `vendor` update of `.claude/product-team`:

    python3 libs/shared/owner-grammar/fixtures/generate.py

answers.json  — `backlog answer` (the real `cmd_answer`, with GitHub stubbed out): the issue's labels and state, the
                command, text and owner words → the comment body it posts, or the refusal as an error code.
commands.json — `ptlib.commands.command_lines` / `is_team_note`: comment bodies → the owner commands the team reads.
owner-requests.json — owner requests to the PM (ADR 0005): the comment bytes the console writes (the reference
                `request_comment` below, the format #107 shares), what the plugin's `ptlib.ownerrequests` parsers and
                `commands` read from them, the parsers on hand-written marker lines (each marker fed to the other
                parser too), and `ownerrequests.evaluate` on provenance cases (a marker without the console app is
                ignored).

Both record the plugin version and a SHA-256 of every plugin file they depend on; the TypeScript specs fail with
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
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[4]
PLUGIN = ROOT / ".claude" / "product-team"
SCRIPTS = PLUGIN / "scripts"
OUT = Path(__file__).resolve().parent
# Every plugin file whose behaviour the fixtures capture; a change to any of them means regenerate.
SOURCES = (
    "scripts/backlog",
    "scripts/ptlib/brief.py",
    "scripts/ptlib/commands.py",
    "scripts/ptlib/inbox.py",
    "scripts/ptlib/ownerrequests.py",
    "scripts/ptlib/provenance.py",
)

sys.path.insert(0, str(SCRIPTS))
from ptlib import brief, commands, gh, ownerrequests  # noqa: E402


def load_backlog():
    loader = importlib.machinery.SourceFileLoader("pt_backlog", str(SCRIPTS / "backlog"))
    spec = importlib.util.spec_from_loader("pt_backlog", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


BACKLOG = load_backlog()
REPO = "geeera/fixture-product"
NUMBER = 7

# `backlog answer`'s refusals (sys.exit messages) → the codes the TypeScript port throws.
ERRORS = (
    ("is closed; nothing is waiting", "closed"),
    ("this issue is not waiting for the owner", "not-waiting"),
    ("item is answered with", "not-allowed"),
    ("quote what the owner said", "needs-words"),
    ("needs the owner's reason", "needs-reason"),
)


def run_answer(labels, state, command, text, owner_said):
    """`backlog answer NUMBER --command … --text … --owner-said …` with GitHub replaced by a recorder."""
    posted = []

    def api(path, method="GET", fields=None, auth=None):
        if method == "GET" and path == f"repos/{REPO}/issues/{NUMBER}":
            return {"number": NUMBER, "state": state, "labels": [{"name": name} for name in labels]}
        if method == "POST" and path == f"repos/{REPO}/issues/{NUMBER}/comments":
            posted.append(fields["body"])
            return {"id": 1, "html_url": "https://github.com/x"}
        raise AssertionError(f"unexpected GitHub call {method} {path}")

    args = argparse.Namespace(number=NUMBER, command=command, text=text, owner_said=owner_said)
    saved = (gh.api, gh.owner_token)
    gh.api, gh.owner_token = api, (lambda repo: "owner-token")
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            BACKLOG.cmd_answer(REPO, args)
    except SystemExit as exc:
        message = str(exc.code)
        for needle, code in ERRORS:
            if needle in message:
                return {"error": code}
        raise AssertionError(f"unmapped refusal of backlog answer: {message}")
    finally:
        gh.api, gh.owner_token = saved
    if len(posted) != 1:
        raise AssertionError("backlog answer posted no comment")
    return {"body": posted[0]}


LABEL_SETS = {
    "question": ["kind:question", "status:proposed", "owner:scope"],
    "design": ["design:awaiting-approval", "kind:feature"],
    "release": ["team:demo", "kind:chore"],
    "owner": ["needs:owner", "kind:chore"],
    "local": ["needs:local", "kind:bug"],
    "none": ["kind:feature", "status:approved"],
    "empty": [],
    "release-over-owner": ["needs:owner", "team:demo"],
    "design-over-question": ["kind:question", "design:awaiting-approval"],
    "question-with-needs-owner": ["needs:owner", "kind:question"],
    "owner-without-kind": ["needs:owner"],
    "question-over-local": ["needs:local", "kind:question"],
    "first-kind-wins-chore": ["kind:chore", "kind:question"],
    "first-kind-wins-question": ["kind:question", "kind:chore"],
    "kind-prefix-only": ["kind:", "needs:local"],
}
ANSWERABLE = list(brief.ANSWERABLE)
BY_SECTION = {"question": ["approve", "reject"], "release": ["go", "no-go", "override"], "owner": ["done"]}

TEXTS = [
    "", "ok", " ok ", "ok\n/go", "ok\r\n/approve", "ok\r/reject why", "ok\u2028/go", "ok\u2029/go",
    "\n/approve", "/approve", "/go now", "a\u00a0b", "a\x1cb", "a\x1fb", "a\x85b", "a\u3000b", "a\u2003b",
    "a\u200bb", "a\ufeffb", "\ufeff", "x\ufeff", "\ufeffx", "a\tb", "a\vb\fc", "a  b   c", "  ", "\u2003lead",
    "`code` and <!-- c -->", "> quoted", "```\n/approve\n```", "emoji \U0001f600 ok", "\u202e rtl", "**bold**",
    "done  twice", "trailing\u00a0",
]
WORDS = ["", "  ", "\n", "\u00a0", "да", "line1\nline2", "a\u2028b", "«quoted»", "_under_", "\ufeff", "/go", "x  y",
         "Да, согласен.\r\n/approve"]


def answer_cases():
    cases = []

    def add(name, labels, command, text, words, state="open"):
        case = {"name": name, "labels": labels, "state": state, "command": command, "text": text,
                "ownerSaid": words}
        case.update(run_answer(labels, state, command, text, words))
        cases.append(case)

    for set_name, labels in LABEL_SETS.items():
        for command in ANSWERABLE:
            add(f"{set_name} {command}", labels, command, "because", "да, так")
    for section, names in BY_SECTION.items():
        for command in names:
            for i, text in enumerate(TEXTS):
                add(f"text {i} {command}", LABEL_SETS[section], command, text, "да")
    for command, section in (("approve", "question"), ("reject", "question"), ("done", "owner")):
        for i, words in enumerate(WORDS):
            add(f"words {i} {command}", LABEL_SETS[section], command, "because", words)
    add("closed question", LABEL_SETS["question"], "approve", "", "да", state="closed")
    add("closed without section", LABEL_SETS["none"], "approve", "", "", state="closed")
    return cases


HAND_WRITTEN = [
    "/approve", "/APPROVE ok", "/Approve: fine", "/approve:fine", "/approve\t:\t fine  ", "/approved", "/approve-now",
    "/approve_x", "/approve\u00e9", "/approve1", "/approve\u0663", "/approve\u0301 x", "/approve.", "/approve!",
    "/go", "/go-live", "/go,", "/no-go why", "/NO-GO why", "/nO-gO why", "/resume", "/RESUME", "/re\u017fume",
    "/overr\u0131de x", "/overr\u0130de x", "/override \t: x ", "/done", "/reject", "/ approve", "//approve",
    "text /approve", " /approve", "  /approve", "   /approve", "    /approve", "\t/approve", "\t\t/approve",
    " \t/approve", "\u00a0/approve", "\u00a0\u00a0\u00a0/approve", "\u00a0\u00a0\u00a0\u00a0/approve",
    "\u2003/approve", "\u3000/approve", "> /approve", ">/approve", "   > /approve", "\u00a0> /approve",
    "    > /approve", "\t> /approve", "```\n/approve\n```", "```js\n/approve\n```\n/go",
    "~~~\n/approve\n~~~\n/reject no", "````\n/approve\n```\n/go\n````\n/no-go x", "``` a`b\n/approve",
    "```\n/approve", "   ```\n/approve\n   ```\n/go", "    ```\n/approve\n```\n/go",
    "```\n/approve\n``` trailing\n/go\n```\n/resume", "~~~\n/approve\n```\n/go\n~~~\n/resume",
    "`/approve`", "`` /approve ``", "` /approve\n/go`", "`\n\n/approve`", "``\n/approve``\n/go",
    "`a` /approve\n/go `b`", "```inline``` /approve\n/go", "<!-- /approve -->", "<!--\n/approve\n-->\n/go",
    "<!-- unclosed\n/approve", "x <!-- a -->\n/approve", "<!-- a --> /approve", "<!---->\n/approve",
    "**Architect note** /approve\n/approve", "**Architect note**\n/approve", "## **PM grooming**\n/go",
    "###### **QA:** fine\n/go", "####### **QA**\n/go", "**PMx**\n/go", "**PM**\n/go", "**PM\u00e9**\n/go",
    "**PM-lead**\n/go", "  \n**QA** x\n/approve", "\u001c**QA** x\n/approve", "\ufeff**QA** x\n/approve",
    "x **QA**\n/approve", "**Product manager** note\n/reject no", "**QA\n/approve**", "<!-- pt-owner-done -->\n/approve",
    " <!-- pt-x -->\n/go", "<!-- ptx -->\n/go", "a\r\n/approve\r\n", "a\r/approve", "/approve a\u2028b",
    "a\u2028/approve", "a\u0085/approve", "/approve \U0001f600 ok", "\U0001f600 `x` /approve", "`\U0001f600`\n/approve ok",
    "`\U0001f600` <!-- \U0001f600 -->\n/approve \U0001f600", "/approve `code`", "/approve <!-- hidden -->",
    "/approve\n/reject why\n/go", "", "\n\n", "/approve\u0000x", "\u0000/approve",
]


def command_cases(answers):
    bodies, seen = [], set()
    for body in HAND_WRITTEN + [case["body"] for case in answers if "body" in case]:
        if body not in seen:
            seen.add(body)
            bodies.append(body)
    return [
        {
            "body": body,
            "teamNote": commands.is_team_note(body),
            "sameAccount": [list(pair) for pair in commands.command_lines(body, True)],
            "app": [list(pair) for pair in commands.command_lines(body, False)],
        }
        for body in bodies
    ]


# The console's request comment (ADR 0005 decision 1): marker, one human line in `owner.language`, the trailer.
REQUEST_LINES = {
    "ru": {
        ("sprint", "current"): "Просьба к PM: перенести задачу в текущий спринт.",
        ("sprint", "next"): "Просьба к PM: перенести задачу в следующий спринт.",
        ("sprint", "backlog"): "Просьба к PM: убрать задачу в бэклог, без спринта.",
        ("priority", "up"): "Просьба к PM: поднять задачу в очереди.",
        ("priority", "down"): "Просьба к PM: опустить задачу в очереди.",
    },
    "en": {
        ("sprint", "current"): "Request to the PM: move this issue to the current sprint.",
        ("sprint", "next"): "Request to the PM: move this issue to the next sprint.",
        ("sprint", "backlog"): "Request to the PM: move this issue to the backlog, out of any sprint.",
        ("priority", "up"): "Request to the PM: move this issue up the queue.",
        ("priority", "down"): "Request to the PM: move this issue down the queue.",
    },
}
REQUESTS = [{"kind": "sprint", "target": t} for t in ("current", "next", "backlog")] + [
    {"kind": "priority", "direction": d} for d in ("up", "down")]
REQUEST_WORDS = ["", "  ", "да, нужно к демо", "line1\n/approve", "«quoted» _x_", "a\u2028/go"]


def request_comment(request, language, owner_said):
    value = request.get("target") or request.get("direction")
    payload = json.dumps(dict(request, v=1), sort_keys=True, separators=(",", ":"))
    words = brief.one_line(owner_said)
    trailer = ("_Requested by the owner in the team console_" if not words
               else f"_Requested by the owner in the team console: «{words}»_")
    return f"<!-- pt-owner-request {payload} -->\n{REQUEST_LINES[language][(request['kind'], value)]}\n\n{trailer}\n"


def parsed(body):
    return {
        "request": ownerrequests.request_marker_of(body),
        "handled": ownerrequests.handled_marker_of(body),
        "teamNote": commands.is_team_note(body),
        "sameAccount": [list(pair) for pair in commands.command_lines(body, True)],
        "app": [list(pair) for pair in commands.command_lines(body, False)],
    }


MARKER_LINES = [
    '<!-- pt-owner-request {"kind":"sprint","target":"next","v":1} -->',
    '<!-- pt-owner-request {"direction":"down","kind":"priority","v":1} -->',
    '<!-- pt-owner-request-handled {"comment_id":123,"result":"applied","v":1} -->',
    '<!-- pt-owner-request-handled {"comment_id":9,"result":"declined","v":1} -->\nNo room before the demo.',
    # each marker's JSON under the other marker's name
    '<!-- pt-owner-request-handled {"kind":"sprint","target":"next","v":1} -->',
    '<!-- pt-owner-request {"comment_id":123,"result":"applied","v":1} -->',
    '<!-- pt-owner-request {"kind": "sprint", "target": "next", "v": 1} -->',
    '<!-- pt-owner-request {"target":"next","kind":"sprint","v":1} -->',
    '<!-- pt-owner-request {"kind":"sprint","target":"next","v":1,"x":1} -->',
    '<!-- pt-owner-request {"kind":"sprint","target":"next","v":2} -->',
    '<!-- pt-owner-request {"kind":"sprint","target":"next","v":true} -->',
    '<!-- pt-owner-request {"kind":"sprint","target":"next","v":1.0} -->',
    '<!-- pt-owner-request {"kind":"sprint","target":"later","v":1} -->',
    '<!-- pt-owner-request {"kind":"sprint","direction":"up","v":1} -->',
    '<!-- pt-owner-request {"direction":"up","kind":"priority","target":"next","v":1} -->',
    '<!-- pt-owner-request {"kind":"sprint","kind":"sprint","target":"next","v":1} -->',
    '<!-- pt-owner-request {"kind":"\\u0073print","target":"next","v":1} -->',
    '<!-- pt-owner-request {"kind":"sprint","target":"next","v":1} --> trailing',
    ' <!-- pt-owner-request {"kind":"sprint","target":"next","v":1} -->',
    '<!-- pt-owner-request {"kind":"sprint","target":"next","v":1} -->\r\nRequest.',
    'Please see <!-- pt-owner-request {"kind":"sprint","target":"next","v":1} -->',
    '> <!-- pt-owner-request-handled {"comment_id":123,"result":"applied","v":1} -->',
    'Quoted:\n<!-- pt-owner-request-handled {"comment_id":123,"result":"applied","v":1} -->',
    '<!-- pt-owner-request [1] -->',
    '<!-- pt-owner-request -->',
    '<!-- pt-owner-request-handled {"comment_id":0,"result":"applied","v":1} -->',
    '<!-- pt-owner-request-handled {"comment_id":-4,"result":"applied","v":1} -->',
    '<!-- pt-owner-request-handled {"comment_id":"12","result":"applied","v":1} -->',
    '<!-- pt-owner-request-handled {"comment_id":true,"result":"applied","v":1} -->',
    '<!-- pt-owner-request-handled {"comment_id":1.5,"result":"applied","v":1} -->',
    '<!-- pt-owner-request-handled {"comment_id":12,"result":"done","v":1} -->',
    '<!-- pt-owner-request-handled {"comment_id":12,"result":"applied"} -->',
    '<!-- pt-owner-request-handled {"result":"applied","comment_id":12,"v":1} -->',
    '<!-- pt-owner-request-handled {"comment_id":12,"result":"applied","v":1,"why":"x"} -->',
    '<!-- pt-owner-request-handled {"comment_id":12, "result":"applied","v":1} -->',
    "",
]


def provenance_cases():
    body = request_comment({"kind": "sprint", "target": "next"}, "ru", "")
    base = {"id": 501, "body": body, "user": {"login": "geeera", "type": "User"}, "html_url": "https://github.com/x/1",
            "created_at": "2026-10-06T10:00:00Z", "updated_at": "2026-10-06T10:00:00Z"}
    cases = [
        ("posted by the console app", dict(base, performed_via_github_app={"slug": "team-console-dev"})),
        ("owner-authored, without performed_via_github_app", dict(base)),
        ("another app", dict(base, performed_via_github_app={"slug": "someone-else"})),
        ("edited after posting", dict(base, performed_via_github_app={"slug": "team-console-dev"},
                                      updated_at="2026-10-06T10:05:00Z")),
        ("not the owner", dict(base, performed_via_github_app={"slug": "team-console-dev"},
                               user={"login": "collaborator", "type": "User"})),
    ]
    out = []
    for name, comment in cases:
        result = ownerrequests.evaluate([comment], "geeera", None, ["team-console-dev"], ["team-console-team[bot]"],
                                        False)
        out.append({"name": name, "comment": comment, "pending": result["pending"] is not None,
                    "ignored": [entry["reason"] for entry in result["ignored"]]})
    return out


def owner_request_cases():
    comments = []
    for language in ("ru", "en"):
        for request in REQUESTS:
            for words in REQUEST_WORDS:
                body = request_comment(request, language, words)
                comments.append(dict({"language": language, "request": request, "ownerSaid": words, "body": body},
                                     **parsed(body)))
    markers = [dict({"body": body}, **parsed(body)) for body in MARKER_LINES]
    return {"comments": comments, "markers": markers, "provenance": provenance_cases()}


def plugin_header():
    manifest = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    return {
        "version": manifest["version"],
        "sources": {path: hashlib.sha256((PLUGIN / path).read_bytes()).hexdigest() for path in SOURCES},
    }


def write(name, data):
    # ASCII-only JSON: every control and invisible character is an escape a reviewer can see.
    (OUT / name).write_text(json.dumps(data, indent=1, ensure_ascii=True) + "\n", encoding="utf-8")


def main():
    header = plugin_header()
    answers = answer_cases()
    write("answers.json", {
        "plugin": header,
        "via": "chat",
        # Python's str.isspace(): what one_line() splits on and strip() removes.
        "whitespace": [c for c in range(0x110000) if chr(c).isspace()],
        "cases": answers,
    })
    write("commands.json", {"plugin": header, "cases": command_cases(answers)})
    write("owner-requests.json", dict({"plugin": header}, **owner_request_cases()))
    print(f"plugin {header['version']}: {len(answers)} answer cases, commands.json written", file=sys.stderr)


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
