"""Minimal readers for .product-team/project.yml (stdlib only: no YAML parser is guaranteed in cloud sessions)."""
from __future__ import annotations

import re

PROJECT_FILE = ".product-team/project.yml"
# A user login, or a GitHub App's bot login (`<app-slug>[bot]`).
_LOGIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$")


def plugin_ref(path: str = PROJECT_FILE) -> str:
    """The release channel or tag the product follows (`team.plugin_ref`), `stable` by default."""
    try:
        with open(path, encoding="utf-8") as f:
            m = re.search(r"^\s*plugin_ref:\s*['\"]?([\w./-]+)", f.read(), re.MULTILINE)
    except FileNotFoundError:
        return "stable"
    return m.group(1) if m else "stable"


def reviewer_logins(path: str = PROJECT_FILE) -> list:
    """`team.reviewer_logins: a, b` — GitHub logins whose verdicts count: a separate reviewing account, or the
    review app's `<slug>[bot]` login so environments without the review app's key still know it."""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        return []
    return reviewer_logins_from_text(text)


def reviewer_logins_from_text(text: str) -> list:
    """reviewer_logins() of a project.yml given as text (e.g. read from the PR's base branch)."""
    m = re.search(r"^([ \t]*)reviewer_logins:[ \t]*(.*)$", text, re.MULTILINE)
    if not m:
        return []
    inline = m.group(2).split("#", 1)[0].strip()
    if inline:  # `[a, b]`, `a, b` or `[]`; only the outer brackets go, an app login ends in `[bot]`
        body = inline[1:-1] if inline.startswith("[") and inline.endswith("]") else inline
        items = body.split(",")
    else:  # a block list on the following lines: `    - a`
        items = []
        for line in text[m.end():].splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            item = re.match(r"^[ \t]+-[ \t]*([^#]*)", line)
            if not item:
                break
            items.append(item.group(1))
    logins = [x.strip().strip("'\"") for x in items if x.strip().strip("'\"")]
    unreadable = not logins and inline.replace(" ", "") != "[]"
    # Present but unreadable: an empty or mangled list would silently accept the wrong account's verdicts.
    if unreadable or any(not _LOGIN.match(login) for login in logins):
        raise ValueError("team.reviewer_logins is set but could not be read; use `[a, 'app-name[bot]']` or "
                         "`- a` lines of GitHub logins")
    return logins


def owner_language(path: str = PROJECT_FILE) -> str:
    """`owner.language` — the language of questions and the daily digest (en | ru)."""
    try:
        with open(path, encoding="utf-8") as f:
            m = re.search(r"^\s*language:\s*['\"]?(\w+)", f.read(), re.MULTILINE)
    except FileNotFoundError:
        return "en"
    return m.group(1) if m else "en"


def freeze_days(path: str = PROJECT_FILE) -> int:
    try:
        with open(path, encoding="utf-8") as f:
            m = re.search(r"^\s*freeze_days:\s*(\d+)", f.read(), re.MULTILINE)
    except FileNotFoundError:
        return 2
    return int(m.group(1)) if m else 2
