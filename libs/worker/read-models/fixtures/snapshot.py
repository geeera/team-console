#!/usr/bin/env python3
"""Snapshot a product repository's GitHub state into a read-model fixture (#35 golden tests).

  python3 libs/worker/read-models/fixtures/snapshot.py OWNER/REPO OUT.json --today YYYY-MM-DD [--anonymise]

Reads through the vendored plugin's GitHub helper (`.claude/product-team/scripts/ptlib/gh.py`, so the same
credentials a team run has; set PT_REPO=OWNER/REPO for another repository): open issues, open milestones, the issues
of each dated milestone, open pull requests and `.product-team/project.yml`. Only the fields the read models use are
kept, and bodies are cut to BODY_LIMIT characters (the answer line is the first line). `--anonymise` is for private
repositories, whose text must not enter this public repository: titles become "<kind> #<n>", bodies keep only
whether they have an answer line, and pull request titles and project.yml are replaced; numbers, labels, states,
author associations and dates stay as they are.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys

sys.dont_write_bytecode = True
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, ".claude", "product-team", "scripts"))
from ptlib import gh, owner  # noqa: E402

BODY_LIMIT = 1500
ANONYMOUS_YML = "name: Anonymised product\nteam:\n  reviewer_logins: []\n"


def kind_of(raw: dict) -> str:
    return next((l["name"][5:] for l in raw.get("labels", []) if l["name"].startswith("kind:")), "issue")


def issue(raw: dict, anonymise: bool) -> dict:
    body = raw.get("body") or ""
    if anonymise:
        title = f"{kind_of(raw)} #{raw['number']}"
        body = "**Your answer:** /approve (anonymised answer line) · /reject why\n" if owner.ask_of(body) else ""
    else:
        title = raw["title"]
        body = body[:BODY_LIMIT]
    out = {
        "number": raw["number"],
        "title": title,
        "body": body,
        "html_url": raw["html_url"],
        "state": raw["state"],
        "labels": [{"name": l["name"]} for l in raw.get("labels", [])],
        "author_association": raw["author_association"],
        "user": {"login": raw["user"]["login"], "type": raw["user"]["type"]},
        "milestone": ({"number": raw["milestone"]["number"], "title": raw["milestone"]["title"]}
                      if raw.get("milestone") else None),
        "closed_at": raw.get("closed_at"),
    }
    if "pull_request" in raw:
        out["pull_request"] = {"html_url": raw["pull_request"].get("html_url")}
    return out


def milestone(raw: dict) -> dict:
    keep = ("number", "title", "state", "due_on", "html_url", "open_issues", "closed_issues")
    return {k: raw.get(k) for k in keep}


def pull(raw: dict, anonymise: bool) -> dict:
    return {
        "number": raw["number"],
        "title": f"pull request #{raw['number']}" if anonymise else raw["title"],
        "html_url": raw["html_url"],
        "draft": bool(raw.get("draft")),
        "author_association": raw["author_association"],
        "user": {"login": raw["user"]["login"], "type": raw["user"]["type"]},
    }


def project_yml(repo: str) -> str:
    try:
        found = gh.api(f"repos/{repo}/contents/.product-team/project.yml")
    except gh.GhError:
        return ""
    return base64.b64decode(found.get("content") or "").decode("utf-8")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("repo")
    p.add_argument("out")
    p.add_argument("--today", required=True, help="the day the snapshot stands for (sprint pick)")
    p.add_argument("--anonymise", action="store_true")
    args = p.parse_args()
    repo, anon = args.repo, args.anonymise
    milestones = gh.api_list(f"repos/{repo}/milestones?state=open&per_page=100")
    fixture = {
        "source": f"{repo}, snapshot of {args.today}" + (" (anonymised)" if anon else ""),
        "repo": repo,
        "today": args.today,
        "projectYml": ANONYMOUS_YML if anon else project_yml(repo),
        "openIssues": [issue(i, anon) for i in gh.api_list(f"repos/{repo}/issues?state=open&per_page=100")],
        "milestones": [milestone(m) for m in milestones],
        "milestoneIssues": {
            str(m["number"]): [issue(i, anon) for i in
                               gh.api_list(f"repos/{repo}/issues?state=all&milestone={m['number']}&per_page=100")]
            for m in milestones if m.get("due_on")
        },
        "openPulls": [pull(x, anon) for x in gh.api_list(f"repos/{repo}/pulls?state=open&per_page=100")],
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(fixture, f, ensure_ascii=False, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
