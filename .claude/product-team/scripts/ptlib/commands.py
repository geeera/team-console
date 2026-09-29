"""Owner commands in issue comments: /approve, /reject <why>, /go, /no-go <why>, /resume, /override <why>.

A command counts only as the first token of a line of the owner's own prose: not inside a fenced code block, inline
code, a blockquote or an HTML comment. In same-account mode the agents write as the owner's login, so there a
comment that starts with a team note header (`**Architect note**`, `**PM grooming**`, …) or a script marker
(`<!-- pt-… -->`) is the team's and holds no command; as a GitHub App the agents cannot write as the owner, so the
headers are not needed to tell them apart. Owner comments with something that looks like a command but is not read
as one are reported by `rejected`, so a dropped command is never silent.
"""
from __future__ import annotations

import re
from typing import Iterable, List, Optional, Tuple

from . import provenance

COMMANDS = ("approve", "reject", "go", "no-go", "resume", "override")
_NAMES = "approve|reject|go|no-go|resume|override"
# Up to three spaces (or NBSPs), or one tab: more makes an indented code block in Markdown.
_INDENT = r"(?:[  ]{0,3}|\t)"
_LINE = re.compile(r"^%s/(%s)(?![\w-])[ \t:]*(.*)$" % (_INDENT, _NAMES), re.IGNORECASE)
# What 0.10.1 read as a command: any leading whitespace, `\b` after the name. Used only to explain drops.
_LEGACY = re.compile(r"^(\s*)/(?:%s)\b" % _NAMES, re.IGNORECASE)
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_QUOTE = re.compile(r"^%s>" % _INDENT)
_HTML_COMMENT = re.compile(r"<!--.*?(?:-->|\Z)", re.DOTALL)
# A code span: a run of backticks up to the same run, within one paragraph (never across a blank line).
_CODE_SPAN = re.compile(r"(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n).)+?(?<!`)\1(?!`)", re.DOTALL)
# Headers the team's agents start their issue comments with (reference/workflow.md → Approvals).
AGENT_NOTE_ROLES = ("Architect", "PM", "Product manager", "UX", "UI", "Designer", "Design", "Developer", "Dev",
                    "QA", "Reviewer", "Review", "Security", "DevOps", "Analyst", "Scribe", "Team")
AGENT_NOTE = re.compile(r"\A\s*(?:#{1,6}[ \t]+)?\*\*(?:%s)\b[^\n]*?\*\*" % "|".join(re.escape(r) for r in AGENT_NOTE_ROLES))
SCRIPT_MARKER = re.compile(r"\A\s*<!-- pt-")
_MASK = "\x00"

IN_MARKUP = "inside code/quote/comment"
TEAM_NOTE = "starts with a team note header"
INDENTED = "indented 4+ spaces"
NOT_AT_START = "not at line start"
NOT_A_COMMAND = "not a command word"


def _mask(text: str) -> str:
    return re.sub(r"[^\n]", _MASK, text)


def is_team_note(body: str) -> bool:
    """A comment the team wrote: it starts with an agent note header or a script marker."""
    return bool(AGENT_NOTE.match(body or "") or SCRIPT_MARKER.match(body or ""))


def _lines(body: str) -> Tuple[List[str], List[str]]:
    """The body's lines, and the same lines with everything that is not the owner's own prose masked by a
    non-space character (fences, HTML comments, code spans), offsets kept so a command's text comes from the
    original line."""
    body = (body or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = body.split("\n")
    masked_lines, fence = [], None
    for line in lines:
        m = _FENCE.match(line)
        if fence is None and m and not (m.group(1)[0] == "`" and "`" in m.group(2)):
            fence = m.group(1)
            masked_lines.append(_mask(line))
        elif fence is not None:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not m.group(2).strip():
                fence = None
            masked_lines.append(_mask(line))
        else:
            masked_lines.append(line)
    masked = "\n".join(masked_lines)
    masked = _HTML_COMMENT.sub(lambda m: _mask(m.group(0)), masked)
    masked = _CODE_SPAN.sub(lambda m: _mask(m.group(0)), masked)
    return lines, masked.split("\n")


def command_lines(body: str, same_account: bool = True) -> List[tuple]:
    """(command, text) for every line of `body` that is an owner command, in order.

    same_account: the agents can write as the owner's login (gh.acts_as_owner), so team notes are skipped.
    Unknown means True: then an agent's quote can never become the owner's decision.
    """
    if same_account and is_team_note(body):
        return []
    found = []
    for original, line in zip(*_lines(body)):
        if _QUOTE.match(line):
            continue
        m = _LINE.match(line)
        if m:
            found.append((m.group(1).lower(), original[m.start(2):].strip()))
    return found


def unread_reason(body: str, same_account: bool = True) -> str:
    """Why a comment the 0.10.1 parser would have read a command from yields none now, or "" (it yields one, or
    there is nothing command-like in it)."""
    if not any(_LEGACY.match(line) for line in (body or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")):
        return ""
    if command_lines(body, same_account):
        return ""
    if same_account and is_team_note(body):
        return TEAM_NOTE
    for original, line in zip(*_lines(body)):
        legacy = _LEGACY.match(original)
        if not legacy:
            continue
        slash = legacy.end(1)
        if _MASK in line[:slash + 1] or _QUOTE.match(line):
            return IN_MARKUP
        lead = legacy.group(1)
        if not re.fullmatch(_INDENT, lead):
            return INDENTED if re.fullmatch(r"[ \t ]*", lead) else NOT_AT_START
        return NOT_A_COMMAND
    return IN_MARKUP


def parse(comments: Iterable[dict], owner: str, history: Optional[dict], same_account: bool = True) -> List[dict]:
    """Commands from the owner only, oldest first. Anyone else's commands are ignored by design, and so is an owner
    comment someone else edited (history: provenance.fetch of the issue; None or an error = unverifiable edits).
    same_account: gh.acts_as_owner(repo); team notes are skipped only then.
    """
    found = []
    trusted, _ = provenance.screen(comments, [owner], history)
    for c in trusted:
        for command, text in command_lines(c.get("body") or "", same_account):
            found.append(
                {
                    "command": command,
                    "text": text,
                    "at": c.get("created_at") or c.get("createdAt"),
                    "comment_id": c.get("id"),
                    "url": c.get("html_url") or c.get("url"),
                }
            )
    found.sort(key=lambda f: f["at"] or "")
    return found


def rejected(comments: Iterable[dict], owner: str, history: Optional[dict], same_account: bool = True) -> List[dict]:
    """Owner comments whose commands do not count, oldest first, each with `kind` and `reason`:
    `edited` — someone else edited it (or that cannot be ruled out): a security event;
    `not_read` — it looks like a command (0.10.1 would have read one) but is quoted, fenced, indented, in a team
    note, …: nothing is wrong, but the owner may have meant it.
    """
    comments = list(comments)
    with_commands = [c for c in comments if command_lines(c.get("body") or "", same_account)
                     or unread_reason(c.get("body") or "", same_account)]
    trusted, edited = provenance.screen(with_commands, [owner], history)
    out = [dict(e, kind="edited") for e in edited]
    for c in trusted:
        reason = unread_reason(c.get("body") or "", same_account)
        if reason:
            out.append({"comment_id": c.get("id"), "url": c.get("html_url") or c.get("url"),
                        "author": provenance.author_of(c), "at": c.get("created_at"), "kind": "not_read",
                        "reason": f"looks like a command but is not read as one: {reason}"})
    out.sort(key=lambda e: e.get("at") or "")
    return out


def latest(commands: List[dict], names: Iterable[str], since: str = "") -> dict:
    """Most recent command among `names` created after `since` (ISO timestamp), or {}."""
    wanted = set(names)
    hits = [c for c in commands if c["command"] in wanted and (c["at"] or "") > since]
    return hits[-1] if hits else {}
