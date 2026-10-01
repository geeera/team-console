"""Whose words a comment or an issue body really carries: its author, and everyone who ever edited it.

GitHub shows the author of a comment, but anyone with Issues write on the repository (the team app, the review
app, a collaborator) can edit its body afterwards. A statement counts as someone's only when it was never edited
by anyone else. Text, author and edit history come from one GraphQL read (`body`, `userContentEdits`,
`lastEditedAt` + `editor`), so they cannot disagree.

GraphQL is not available everywhere: Claude Code cloud sessions block it (gh.GraphqlUnavailable), and any session
may hit an outage. Then the mode is REST-only (`mode(history) == "rest-only"`): a comment counts only when the
REST timestamps prove it was never edited (`updated_at == created_at`), and every edited comment is untrusted —
including one its own author edited, because REST cannot say who did. That is fail-closed by construction, and
every script keeps working in it; the one thing REST can never verify is an issue body (`body_statement`).
"""
from __future__ import annotations

from typing import Dict, Iterable, List, Optional, Tuple

from . import gh

EDITS_PER_ITEM = 50

_ACTOR = "{ __typename login }"
_EDITABLE = (f"body author {_ACTOR} lastEditedAt editor {_ACTOR} "
             f"userContentEdits(first: {EDITS_PER_ITEM}) {{ totalCount nodes {{ editedAt editor {_ACTOR} }} }}")
# issueOrPullRequest: an owner command on a pull request (a PR number) is checked the same way as on an issue.
_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { %(thread)s }
      ... on PullRequest { %(thread)s }
    }
  }
}
"""
_THREAD = """
      %(editable)s
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { %(ids)s url %(editable)s }
      }
"""
_THREADS = ("Issue", "PullRequest")


def _query(with_full_id: bool) -> str:
    # GitHub Enterprise Server releases without `fullDatabaseId` still answer the url-keyed variant.
    thread = _THREAD % {"editable": _EDITABLE, "ids": "fullDatabaseId" if with_full_id else ""}
    return _QUERY % {"thread": thread}


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


GRAPHQL, REST_ONLY = "graphql", "rest-only"


def fetch(repo: str, number: int) -> dict:
    """Text and edit history of an issue or pull request and all its comments:
    {"issue": record, "comments": {id or url: record}}.

    Never raises for GitHub failures (gh.GraphqlUnavailable included): {"error": why} instead, and callers screen
    with REST timestamps only — every edited item is unverified.
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


def mode(history: Optional[dict]) -> str:
    """How statements were checked: "graphql" (full edit history) or "rest-only" (timestamps; edited = untrusted)."""
    return REST_ONLY if history is None or history.get("error") else GRAPHQL


def _fetch(repo: str, number: int, with_full_id: bool) -> dict:
    owner, _, name = repo.partition("/")
    comments: Dict[str, dict] = {}
    issue_record: Optional[dict] = None
    after: Optional[str] = None
    query = _query(with_full_id)
    while True:
        data = gh.graphql(query, {"owner": owner, "name": name, "number": number, "after": after})
        issue = ((data or {}).get("repository") or {}).get("issueOrPullRequest")
        if not issue or issue.get("__typename") not in _THREADS:
            return {"error": f"GitHub returned no issue or pull request #{number}"}
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


def rest_unedited(item: dict) -> bool:
    """True only when REST timestamps prove a comment was never edited: `updated_at` is exactly `created_at`.

    No slack: GitHub stamps both from the same write, and any tolerance would let an edit made within it count.
    A missing timestamp proves nothing.
    """
    created, updated = item.get("created_at"), item.get("updated_at")
    return bool(created) and created == updated


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
        # Only a comment's timestamps can clear it; an issue body's updated_at moves with every label and comment.
        if is_comment and rest_unedited(item):
            return ""
        why = f"its edit history could not be fetched ({history_error})" if history_error else \
            "GitHub returned no edit history for it"
        return f"it may have been edited and {why}" if is_comment else \
            f"an issue body cannot be verified without its edit history ({why})"
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


def partition(comments: Iterable[dict], authors: Iterable[str], history: Optional[dict],
              editors: Optional[Iterable[str]] = None) -> Tuple[List[dict], List[dict]]:
    """Like `screen`, but the second list holds the rejected comments themselves (REST records, untrusted text) so
    a caller can still see *that* an entry exists without reading anything from it (runstate's `unknown` runs)."""
    comments = list(comments)
    trusted, rejected = screen(comments, authors, history, editors)
    keys = {str(r.get("comment_id") or r.get("url")) for r in rejected}
    return trusted, [c for c in comments if str(c.get("id") or c.get("html_url") or c.get("url")) in keys]


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
