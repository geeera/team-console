#!/usr/bin/env python3
"""Writes artifacts-team-console.json: the GitHub answers the Artifacts readers (#19) use, from geeera/team-console.

Run from the repository root with an authenticated `gh` (read-only calls): `python3 libs/worker/read-models/fixtures/
artifacts_snapshot.py`. Contents entries keep only the fields the readers use; issues keep no body. The repository
has no `team:demo` issue yet, so one hand-made closed demo issue is appended (number 900001) to cover that reader.
"""

import json
import pathlib
import subprocess

REPO = "geeera/team-console"
ENTRY_FIELDS = ("name", "path", "type", "html_url")
ISSUE_FIELDS = ("number", "title", "html_url", "state", "labels", "author_association", "user", "updated_at")


def gh(path: str):
    out = subprocess.run(["gh", "api", path], check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def entries(path: str):
    return [{key: entry.get(key) for key in ENTRY_FIELDS} for entry in gh(f"repos/{REPO}/contents/{path}")]


def slim_issue(issue):
    slim = {key: issue.get(key) for key in ISSUE_FIELDS}
    slim["labels"] = [{"name": label["name"]} for label in issue["labels"]]
    slim["user"] = {"login": issue["user"]["login"], "type": issue["user"]["type"]}
    slim["body"] = ""
    if "pull_request" in issue:
        slim["pull_request"] = {}
    return slim


def main() -> None:
    decisions = entries("docs/decisions")
    headings = {}
    for entry in decisions:
        if entry["type"] == "file" and entry["name"].endswith(".md"):
            text = pathlib.Path(entry["path"]).read_text(encoding="utf-8")
            headings[entry["path"]] = text.splitlines()[0]
    design_root = entries("docs/design")
    design_folders = {
        entry["path"]: entries(entry["path"])
        for entry in design_root
        if entry["type"] == "dir" and entry["name"] != "src"
    }
    design_issues = {}
    for label in ("ux-spec", "design:awaiting-approval", "design:approved"):
        design_issues[label] = [slim_issue(i) for i in gh(f"repos/{REPO}/issues?state=all&labels={label}&per_page=100")]
    demo = [slim_issue(i) for i in gh(f"repos/{REPO}/issues?state=all&labels=team:demo&per_page=100")]
    demo.append(
        {
            "number": 900001,
            "title": "Sprint 1 demo",
            "html_url": f"https://github.com/{REPO}/issues/900001",
            "state": "closed",
            "labels": [{"name": "team:demo"}],
            "author_association": "NONE",
            "user": {"login": "team-console-team[bot]", "type": "Bot"},
            "updated_at": "2026-10-02T09:00:00Z",
            "body": "",
        }
    )
    snapshot = {
        "repo": REPO,
        "decisions": decisions,
        "decisionFirstLines": headings,
        "designRoot": design_root,
        "designFolders": design_folders,
        "designIssues": design_issues,
        "demoIssues": demo,
    }
    out = pathlib.Path(__file__).with_name("artifacts-team-console.json")
    out.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
