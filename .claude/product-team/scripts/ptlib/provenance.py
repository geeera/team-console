"""Whose words a comment or an issue body really carries: its author, and everyone who ever edited it.

GitHub shows the author of a comment, but anyone with Issues write on the repository (the team app, the review
app, a collaborator) can edit its body afterwards. A statement counts as someone's only when it was never edited
by anyone else. Text, author and edit history come from one GraphQL read (`body`, `userContentEdits`,
`lastEditedAt` + `editor`), so they cannot disagree; when that read fails, only text the REST timestamps show was
never edited counts. Everything else fails closed.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional, Tuple

from . import gh

# REST `updated_at` of a never-edited comment equals `created_at`; a second of slack absorbs rounding.
TOLERANCE = timedelta(seconds=2)
EDITS_PER_ITEM = 50

_ACTOR = "{ __typename login }"
_EDITABLE = (f"body author {_ACTOR} lastEditedAt editor {_ACTOR} "
             f"userContentEdits(first: {EDITS_PER_ITEM}) {{ totalCount nodes {{ editedAt editor {_ACTOR} }} }}")
_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      %(editable)s
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { %(ids)s url %(editable)s }
      }
    }
  }
}
"""


def _query(with_full_id: bool) -> str:
    # GitHub Enterprise Server releases without `fullDatabaseId` still answer the url-keyed variant.
    return _QUERY % {"editable": _EDITABLE, "ids": "fullDatabaseId" if with_full_id else ""}


def _login(actor: Optional[dict]) -> Optional[str]:
    """GraphQL names a GitHub App's bot `slug`; REST (and everything else here) calls it `slug[bot]`."""
    if not actor or not actor.get("login"):
        return None  # a deleted account: nobody can vouch for its edit
    login = actor["login"]
    if actor.get("__typename") == "Bot" and not login.endswith("[bot]"):
        login += "[bot]"
    return login


def _record(node: dict) -> dict:
    edits = node.get("userContentEdits") or {}
    nodes = edits.get("nodes") or []
    editors = [_login(e.get("editor")) for e in nodes]
    edited = bool(node.get("lastEditedAt")) or bool(edits.get("totalCount"))
    if node.get("lastEditedAt"):
        editors.append(_login(node.get("editor")))
    return {
        "body": node.get("body"),
        "author": _login(node.get("author")),
        "edited": edited,
        "edited_at": node.get("lastEditedAt"),
        "editors": editors,
        # An edit GitHub reports without any history entries cannot be attributed: it counts as unchecked.
        "complete": (edits.get("totalCount") or 0) <= len(nodes) and not (edited and not nodes),
    }


def fetch(repo: str, number: int) -> dict:
    """Text and edit history of an issue and all its comments: {"issue": record, "comments": {id or url: record}}.

    Never raises for GitHub failures: {"error": why} instead, and callers treat every edited item as unverified.
    """
    try:
        return _fetch(repo, number, with_full_id=True)
    except gh.GhError as exc:
        if "fullDatabaseId" not in str(exc):
            return {"error": str(exc)}
    try:
        return _fetch(repo, number, with_full_id=False)
    except gh.GhError as exc:
        return {"error": str(exc)}


def _fetch(repo: str, number: int, with_full_id: bool) -> dict:
    owner, _, name = repo.partition("/")
    comments: Dict[str, dict] = {}
    issue_record: Optional[dict] = None
    after: Optional[str] = None
    query = _query(with_full_id)
    while True:
        data = gh.graphql(query, {"owner": owner, "name": name, "number": number, "after": after})
        issue = ((data or {}).get("repository") or {}).get("issue")
        if not issue:
            return {"error": f"GitHub returned no issue #{number}"}
        if issue_record is None:
            issue_record = _record(issue)
        page = issue.get("comments") or {}
        for node in page.get("nodes") or []:
            record = _record(node)
            for key in (node.get("fullDatabaseId"), node.get("url")):
                if key:
                    comments[str(key)] = record
        info = page.get("pageInfo") or {}
        if not info.get("hasNextPage"):
            break
        after = info.get("endCursor")
    return {"issue": issue_record, "comments": comments}


def _ts(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def rest_unedited(item: dict) -> bool:
    """True only when REST timestamps prove the item was never edited; a missing or odd timestamp proves nothing."""
    created, updated = item.get("created_at"), item.get("updated_at")
    if not created or not updated:
        return False
    if created == updated:
        return True
    a, b = _ts(created), _ts(updated)
    return a is not None and b is not None and abs(b - a) <= TOLERANCE


def author_of(item: dict) -> str:
    return ((item.get("user") or item.get("author") or {}).get("login") or "")


def _describe(allowed: set) -> str:
    return " or ".join(sorted(allowed)) or "nobody"


def edit_problem(item: dict, record: Optional[dict], allowed: Iterable[str], history_error: str = "",
                 is_comment: bool = True) -> str:
    """Why an item's text is not its author's own words, or "" when it is.

    record: its GraphQL read (None when GitHub did not return one). allowed: logins whose edits keep it
    trustworthy — the owner for owner statements, the team's logins for the team's own run log. is_comment: REST
    `updated_at` tracks only body edits (an issue's moves with every label, so it is not compared).
    """
    allowed_lower = {a.lower() for a in allowed if a}
    if record is None:
        if rest_unedited(item):
            return ""
        why = f"its edit history could not be fetched ({history_error})" if history_error else \
            "GitHub returned no edit history for it"
        return f"it may have been edited and {why}"
    if record.get("author") and record["author"].lower() != author_of(item).lower():
        return f"GitHub names two authors for it ({author_of(item)}, {record['author']})"
    if not record["edited"]:
        if is_comment and not rest_unedited(item):
            # Two reads of GitHub disagree about whether it was edited: trust neither.
            return "REST shows it edited but the edit history shows no edit"
        return ""
    if not record["complete"]:
        return (f"its edit history is incomplete (more than {EDITS_PER_ITEM} edits, or an edit without history "
                "entries); it cannot be checked")
    strangers = sorted({e or "a deleted account" for e in record["editors"] if not e or e.lower() not in allowed_lower})
    if strangers:
        return f"it was edited by {', '.join(strangers)}, not only by {_describe(allowed_lower)}"
    return ""


def comment_record(history: Optional[dict], comment: dict) -> Optional[dict]:
    known = (history or {}).get("comments") or {}
    for key in (comment.get("id"), comment.get("html_url"), comment.get("url")):
        if key is not None and str(key) in known:
            return known[str(key)]
    return None


def screen(comments: Iterable[dict], authors: Iterable[str], history: Optional[dict],
           editors: Optional[Iterable[str]] = None) -> Tuple[List[dict], List[dict]]:
    """Split comments by `authors` into (trusted, rejected-with-reason). Comments by anyone else are dropped.

    Trusted comments carry the body of the GraphQL read their history came from (the REST body only when GitHub
    returned no history and REST shows the comment unedited). editors: whose edits keep a comment trustworthy;
    defaults to the authors themselves. history None or {"error": …}: only REST-unedited comments are trusted.
    """
    author_set = {a.lower() for a in authors if a}
    editor_set = set(editors) if editors is not None else set(authors)
    error = (history or {}).get("error", "") or ("" if history is not None else "not requested")
    trusted, rejected = [], []
    for c in comments:
        if author_of(c).lower() not in author_set:
            continue
        record = comment_record(history, c)
        problem = edit_problem(c, record, editor_set, error)
        if problem:
            rejected.append({"comment_id": c.get("id"), "url": c.get("html_url") or c.get("url"),
                             "author": author_of(c), "at": c.get("created_at"), "reason": problem})
        elif record is not None:
            trusted.append(dict(c, body=record.get("body") or ""))
        else:
            trusted.append(c)
    return trusted, rejected


def body_statement(issue: dict, owner: str, history: Optional[dict]) -> dict:
    """Whether an issue's body is the owner's own words, and who changed it when (for approvals given before)."""
    record = (history or {}).get("issue")
    error = (history or {}).get("error", "") or ("" if history is not None else "not requested")
    author = author_of(issue)
    if author.lower() != owner.lower():
        reason = f"written by {author or 'an unknown account'}, not by {owner}"
    else:
        reason = edit_problem(issue, record, {owner}, error, is_comment=False)
    return {
        "author": author,
        "owner_statement": not reason,
        "reason": reason,
        "body": (record or {}).get("body") if not reason else None,
        # An issue's REST updated_at moves with every label or comment, so only GraphQL can date a body edit.
        "edited_at": (record or {}).get("edited_at"),
        "editors": sorted({e or "a deleted account" for e in (record or {}).get("editors", [])}),
    }
