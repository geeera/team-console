"""Owner requests to the PM (geeera/team-console ADR 0005): "put #N into the next sprint", "move #N up the queue".

The team console posts a request as an issue comment on the owner's own token; the PM honours it at planning time
within the sprint caps and the freeze rule, or declines it, and answers with a handled marker. A request is advice,
never an owner command: its first line is a `<!-- pt-` script marker, so `commands.parse` never reads it.

  request  line 1: <!-- pt-owner-request {"kind":"sprint","target":"next","v":1} -->
  handled  line 1: <!-- pt-owner-request-handled {"comment_id":123,"result":"applied","v":1} -->

Both parsers anchor on the whole first line and accept only the canonical JSON (sorted keys, no whitespace, exactly
the known fields): `<!-- pt-owner-request` is a prefix of `<!-- pt-owner-request-handled`, and a quote in prose or
a shape this version does not know must do nothing.

A request counts only when all of ADR 0005 decision 2 hold — the repository owner wrote it, nobody ever edited it,
and GitHub says one of the console's apps (`team.console_app_slugs`) posted it — and, until GitHub is verified to
set `performed_via_github_app` on user-to-server comments, never in a session where an agent can write as the
owner (`gh.acts_as_owner`). Owner authorship alone proves nothing there: an agent holding the owner's credential
posts as the owner's login.
"""
from __future__ import annotations

import json
import re
from typing import Iterable, List, Optional

from . import provenance

REQUEST_PREFIX = "<!-- pt-owner-request"
_REQUEST = re.compile(r"\A<!-- pt-owner-request (\{[^\n]*\}) -->\Z")
_HANDLED = re.compile(r"\A<!-- pt-owner-request-handled (\{[^\n]*\}) -->\Z")
TARGETS = ("current", "next", "backlog")
DIRECTIONS = ("up", "down")
RESULTS = ("applied", "declined")


def first_line(body: str) -> str:
    """The comment's first line; a CRLF line end is GitHub's, not part of the marker."""
    line = (body or "").split("\n", 1)[0]
    return line[:-1] if line.endswith("\r") else line


def _canonical(raw: str) -> Optional[dict]:
    """The JSON object in `raw`, only when `raw` is exactly its sorted-key, whitespace-free form."""
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict) or json.dumps(data, sort_keys=True, separators=(",", ":")) != raw:
        return None  # duplicate keys, spacing, key order or escapes: not the bytes the console writes
    return data


def _is_int(value: object) -> bool:
    return type(value) is int  # bool is an int subclass; `true` is not a version or an id


def request_marker_of(body: str) -> Optional[dict]:
    """{"kind": "sprint", "target": …} or {"kind": "priority", "direction": …} from a request comment, else None."""
    m = _REQUEST.match(first_line(body))
    data = _canonical(m.group(1)) if m else None
    if data is None or not _is_int(data.get("v")) or data["v"] != 1:
        return None
    if data.get("kind") == "sprint" and set(data) == {"kind", "target", "v"} and data["target"] in TARGETS:
        return {"kind": "sprint", "target": data["target"]}
    if data.get("kind") == "priority" and set(data) == {"direction", "kind", "v"} and data["direction"] in DIRECTIONS:
        return {"kind": "priority", "direction": data["direction"]}
    return None


def handled_marker_of(body: str) -> Optional[dict]:
    """{"comment_id": int, "result": "applied" | "declined"} from a handled comment, else None."""
    m = _HANDLED.match(first_line(body))
    data = _canonical(m.group(1)) if m else None
    if data is None or set(data) != {"comment_id", "result", "v"}:
        return None
    if not (_is_int(data["v"]) and data["v"] == 1 and _is_int(data["comment_id"]) and data["comment_id"] > 0):
        return None
    if data["result"] not in RESULTS:
        return None
    return {"comment_id": data["comment_id"], "result": data["result"]}


def handled_marker(comment_id: int, result: str) -> str:
    if not _is_int(comment_id) or comment_id <= 0:
        raise ValueError(f"comment_id must be a positive integer, not {comment_id!r}")
    if result not in RESULTS:
        raise ValueError(f"result must be one of {', '.join(RESULTS)}, not {result!r}")
    payload = json.dumps({"comment_id": comment_id, "result": result, "v": 1}, sort_keys=True, separators=(",", ":"))
    return f"<!-- pt-owner-request-handled {payload} -->"


_SAID = {
    "en": {"applied": "**PM note**: your request is applied.", "declined": "**PM note**: your request is declined."},
    "ru": {"applied": "**PM note**: твоя просьба выполнена.", "declined": "**PM note**: твоя просьба отклонена."},
}


def handled_comment(comment_id: int, result: str, reason: str, request_url: str, language: str = "en") -> str:
    """The PM's answer to a request: the marker on the first line, then one human line and the reason."""
    from .brief import one_line  # owner-facing text is one line, like an answer
    reason = one_line(reason)
    if result == "declined" and not reason:
        raise ValueError("a declined request needs the reason (--text): the owner is told why not")
    said = _SAID.get(language, _SAID["en"])[result]
    lines = [handled_marker(comment_id, result), f"{said} {request_url}".rstrip()]
    if reason:
        lines += ["", reason]
    return "\n".join(lines) + "\n"


def describe(request: dict) -> str:
    return f"sprint → {request['target']}" if request["kind"] == "sprint" else f"queue → {request['direction']}"


def _app_slug(comment: dict) -> str:
    return ((comment.get("performed_via_github_app") or {}).get("slug") or "")


def _unedited(comments: List[dict], authors: Iterable[str], history: Optional[dict]) -> tuple:
    # No allowed editors: a request or a handled marker counts only as first written, an owner's own edit included,
    # since an agent holding the owner's credential edits as the owner.
    return provenance.screen(comments, authors, history, editors=())


def evaluate(comments: List[dict], owner: str, history: Optional[dict], app_slugs: Iterable[str],
             team_logins: Iterable[str], acts_as_owner: bool, since: str = "") -> dict:
    """The requests on one issue: {"pending": request or None, "handled": [...], "ignored": [...]}.

    comments: the issue's REST comments; history: provenance.fetch of the issue (None or an error = REST-only).
    The newest honoured request replaces older ones; it is pending until the team answered it with a handled marker
    (by a team login other than the owner's, unedited, created after it). since: ISO timestamp; honoured requests
    created before it are outside the lookback. Every request marker that does not count is in `ignored` with the
    reason, so a dropped request is never silent.
    """
    slugs = set(app_slugs)
    candidates = [c for c in comments if request_marker_of(c.get("body") or "")]
    ignored = []

    def drop(c: dict, reason: str) -> None:
        ignored.append({"comment_id": c.get("id"), "url": c.get("html_url") or c.get("url"),
                        "author": provenance.author_of(c), "at": c.get("created_at"), "reason": reason})

    for c in candidates:
        if provenance.author_of(c).lower() != owner.lower():
            drop(c, f"not written by the owner ({owner})")
    trusted, edited = _unedited(candidates, [owner], history)
    for e in edited:
        ignored.append(dict(e, reason=f"{e['reason']}; a request counts only as first written"))
    honoured = []
    for c in trusted:
        slug = _app_slug(c)
        if not request_marker_of(c.get("body") or ""):
            drop(c, "its verified text is not a request")  # screen hands back the edit history's body
        elif not slugs:
            drop(c, "team.console_app_slugs is not set in .product-team/project.yml on the default branch: no "
                    "console app is known")
        elif slug not in slugs:
            drop(c, f"not posted by the team console (performed_via_github_app: {slug or 'none'}; "
                    f"expected one of {', '.join(sorted(slugs))})")
        elif acts_as_owner:
            drop(c, "an agent in this session can write as the owner (acts_as_owner): requests are not honoured "
                    "until the team works as its GitHub App without the owner's credential")
        elif since and (c.get("created_at") or "") < since:
            drop(c, f"older than the lookback (created before {since}); the owner can ask again")
        else:
            honoured.append(c)
    honoured.sort(key=lambda c: (c.get("created_at") or "", c.get("id") or 0))

    # Never the owner's login: whoever holds the owner's credential (a cloud routine, an injected agent) could
    # otherwise mark a real request handled and drop it silently. request-done never posts as the owner.
    answerers = [login for login in team_logins if login and login.lower() != owner.lower()]
    marked, _ = _unedited([c for c in comments if handled_marker_of(c.get("body") or "")], answerers, history)
    marks = [(m, handled_marker_of(m.get("body") or "")) for m in marked]
    handled = []
    for c in honoured:
        answers = [(m, mark) for m, mark in marks if mark and mark["comment_id"] == c.get("id")
                   and (m.get("created_at") or "") > (c.get("created_at") or "")]
        if answers:
            last, mark = max(answers, key=lambda pair: pair[0].get("created_at") or "")
            handled.append({"comment_id": c.get("id"), "result": mark["result"], "at": last.get("created_at"),
                            "url": last.get("html_url")})
    newest = honoured[-1] if honoured else None
    pending = None
    if newest is not None and newest.get("id") not in {h["comment_id"] for h in handled}:
        pending = dict(request_marker_of(newest["body"]), comment_id=newest.get("id"),
                       url=newest.get("html_url"), at=newest.get("created_at"), via=_app_slug(newest))
    ignored.sort(key=lambda e: e.get("at") or "")
    return {"pending": pending, "handled": handled, "ignored": ignored}
