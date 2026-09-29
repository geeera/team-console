"""GitHub access for the plugin scripts: the REST API over HTTPS with the session's token, no `gh` CLI needed.

Cloud sessions have a token in the environment but not always the `gh` binary, so this module talks to the API
directly. Token lookup: the team GitHub App when PT_TEAM_APP_ID is set (ghapp.py, reference/identities.md), else
GH_TOKEN, GITHUB_TOKEN, then `gh auth token` when the CLI happens to exist. With no token at all requests go out
unauthenticated, which still works where a proxy adds credentials.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from typing import Any, List, Optional, Tuple

API = os.environ.get("PT_GITHUB_API", "https://api.github.com").rstrip("/")
_NEXT = re.compile(r'<([^>]+)>;\s*rel="next"')
_REMOTE = re.compile(r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?/?$")
_token_cache: Optional[str] = None
_cli_token_cache: Optional[str] = None
_DENIED = re.compile(r"→ HTTP 40[13]\b")
# Identity secrets are stripped from every child process the scripts start.
_SECRET_ENV = re.compile(r"^PT_(TEAM|REVIEW)_APP_KEY|^PT_OWNER_TOKEN$|^PT_REVIEW_TOKEN$")


class GhError(RuntimeError):
    pass


def token() -> str:
    """The agents' token: the team app's installation token when configured, else the personal-token chain."""
    from . import ghapp  # deferred: ghapp builds on this module
    if ghapp.configured("team"):
        # A configured app that fails is an error: silently falling back would act as the owner again.
        return ghapp.installation_token("team", repo())
    return personal_token()


def child_env(**extra: str) -> dict:
    """os.environ for a child process, without the identity secrets: git, openssl and gh never need them."""
    env = {k: v for k, v in os.environ.items() if not _SECRET_ENV.match(k)}
    env.update(extra)
    return env


def _run_gh_auth_token() -> "subprocess.CompletedProcess[str]":
    """The one place a real credential is read from the `gh` CLI (the test suite replaces it with a tripwire)."""
    return subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=False, env=child_env())


def _gh_cli_token() -> str:
    global _cli_token_cache
    if _cli_token_cache is None:
        _cli_token_cache = ""
        if shutil.which("gh"):
            proc = _run_gh_auth_token()
            _cli_token_cache = proc.stdout.strip() if proc.returncode == 0 else ""
    return _cli_token_cache


def personal_token() -> str:
    """GH_TOKEN, GITHUB_TOKEN or `gh auth token`: the agents' token when no team app is configured."""
    global _token_cache
    if _token_cache is None:
        _token_cache = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or _gh_cli_token()
    return _token_cache


def personal_credentials() -> List[str]:
    """Every personal credential present in this session (PT_OWNER_TOKEN, GH_TOKEN, GITHUB_TOKEN, `gh auth`)."""
    found = [os.environ.get(name, "").strip() for name in ("PT_OWNER_TOKEN", "GH_TOKEN", "GITHUB_TOKEN")]
    found.append(_gh_cli_token())
    return list(dict.fromkeys(c for c in found if c))


def _request(method: str, url: str, body: Optional[dict] = None, accept: str = "application/vnd.github+json",
             auth: Optional[str] = None) -> Tuple[str, dict]:
    headers = {"Accept": accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "product-team-plugin"}
    credential = auth if auth is not None else token()
    if credential:
        headers["Authorization"] = f"Bearer {credential}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read().decode("utf-8"), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise GhError(f"{method} {url} → HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise GhError(f"{method} {url} failed: {exc.reason}") from exc
    except (OSError, http.client.HTTPException) as exc:  # timeouts, dropped connections
        raise GhError(f"{method} {url} failed: {exc!r}") from exc


def _json(text: str, what: str) -> Any:
    try:
        return json.loads(text) if text.strip() else None
    except ValueError as exc:  # e.g. an HTML error page from a proxy
        raise GhError(f"{what}: expected JSON, got {text[:120]!r}") from exc


def _url(path: str) -> str:
    return path if path.startswith("http") else f"{API}/{path.lstrip('/')}"


def api(path: str, method: str = "GET", fields: Optional[dict] = None, auth: Optional[str] = None) -> Any:
    text, _ = _request(method, _url(path), fields, auth=auth)
    return _json(text, f"{method} {path}")


def api_list(path: str) -> List[Any]:
    """Every item of a paginated list endpoint (follows Link: rel="next")."""
    items: List[Any] = []
    url: Optional[str] = _url(path)
    while url:
        text, headers = _request("GET", url)
        page = _json(text, f"GET {url}") or []
        # Some list endpoints wrap the array, e.g. check-runs → {"total_count", "check_runs": [...]}.
        if isinstance(page, dict):
            page = next((v for v in page.values() if isinstance(v, list)), [])
        items.extend(page)
        match = _NEXT.search(headers.get("Link") or headers.get("link") or "")
        url = match.group(1) if match else None
    return items


def raw(path: str, accept: str) -> str:
    """A non-JSON representation, e.g. a pull request diff."""
    text, _ = _request("GET", _url(path), accept=accept)
    return text


def graphql(query: str, variables: dict) -> Any:
    result = api("graphql", "POST", {"query": query, "variables": variables})
    if result and result.get("errors"):
        raise GhError(f"GraphQL: {result['errors']}")
    return (result or {}).get("data")


def parse_remote(url: str) -> Optional[str]:
    """owner/repo from a GitHub remote URL, including proxied ones that keep the github.com/owner/repo tail."""
    m = _REMOTE.search(url.strip())
    if m:
        return f"{m.group(1)}/{m.group(2)}"
    parts = [p for p in re.split(r"[/:]", url.strip().rstrip("/")) if p]
    if len(parts) < 2:
        return None
    name = parts[-1][:-4] if parts[-1].endswith(".git") else parts[-1]
    return f"{parts[-2]}/{name}"


def repo() -> str:
    """owner/repo: PT_REPO, else `repo:` in .product-team/project.yml, else the origin remote."""
    explicit = os.environ.get("PT_REPO")
    if explicit:
        return explicit
    try:
        with open(".product-team/project.yml", encoding="utf-8") as f:
            m = re.search(r"^repo:\s*['\"]?([\w.-]+/[\w.-]+)", f.read(), re.MULTILINE)
        if m:
            return m.group(1)
    except FileNotFoundError:
        pass
    proc = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True, check=False,
                          env=child_env())
    found = parse_remote(proc.stdout) if proc.returncode == 0 else None
    if not found:
        raise GhError("cannot tell the repository: set PT_REPO=owner/repo or `repo:` in .product-team/project.yml")
    return found


def review_token() -> Optional[str]:
    """The reviewers' token: the review app's, else PT_REVIEW_TOKEN (a reviewing account), else None (= token())."""
    from . import ghapp
    if ghapp.configured("review"):
        review_login()  # refuses a review app that is really the team app
        return ghapp.installation_token("review", repo())
    return os.environ.get("PT_REVIEW_TOKEN") or None


def app_mode() -> bool:
    """True when the agents write as the team GitHub App rather than a personal account."""
    from . import ghapp
    return ghapp.configured("team")


def app_identity() -> dict:
    """The team app's bot: login, user id, and the name/email its commits carry. Only in app mode."""
    from . import ghapp
    return ghapp.identity("team", repo())


def review_login() -> Optional[str]:
    """The review app's bot login when the review app is configured, else None.

    Two ids can name one app (numeric id and Iv… client id), so the bots are compared, not the configured ids.
    """
    from . import ghapp
    if not ghapp.configured("review"):
        return None
    login = ghapp.identity("review", repo())["login"]
    if app_mode() and login.lower() == app_identity()["login"].lower():
        raise GhError(f"PT_REVIEW_APP_ID and PT_TEAM_APP_ID are the same app ({login}): the review app must be a "
                      "separate GitHub App, or the team could approve its own work")
    return login


def _user_login(credential: Optional[str] = None) -> Optional[str]:
    """The login behind a credential; None when GitHub refuses it /user (401/403, e.g. an Actions token).

    Any other failure (5xx, timeout, network) raises: it says nothing about whose credential it is.
    """
    try:
        return (api("user", auth=credential) or {}).get("login") or None
    except GhError as exc:
        if _DENIED.search(str(exc)):
            return None
        raise


def token_login() -> Optional[str]:
    """The account the agents act as; None when it cannot be told (e.g. an Actions token without /user access).

    In app mode that is the team app's bot, known from the app itself: installation tokens cannot call GET /user.
    """
    return app_identity()["login"] if app_mode() else _user_login()


def acts_as_owner(repo_name: str) -> bool:
    """True when an agent in this session can write as the owner's account — or that cannot be ruled out.

    Same-account mode: the agents' own login is compared. App mode: the bot is not the owner, but any personal
    credential in the session that resolves to the owner (PT_OWNER_TOKEN, GH_TOKEN, GITHUB_TOKEN, `gh auth`) lets
    an agent post as them, so its presence fails closed too.
    """
    owner = owner_login(repo_name).lower()
    try:
        login = token_login()
        if login is None or login.lower() == owner:
            return True
        if not app_mode():
            return False
        return any((_user_login(c) or "").lower() == owner for c in personal_credentials())
    except GhError:
        return True  # an outage cannot rule out that a credential here is the owner's


def owner_token(repo_name: str) -> Optional[str]:
    """The token that posts the owner's own words (`backlog answer`); None = the agents' token already is theirs.

    App mode: only PT_OWNER_TOKEN, a credential the owner gives the team-chat session on purpose — never GH_TOKEN,
    GITHUB_TOKEN or `gh auth`, which may be there for other reasons — and only when it resolves to the owner.
    """
    if not app_mode():
        return None
    credential = os.environ.get("PT_OWNER_TOKEN", "").strip()
    owner = owner_login(repo_name)
    login = _user_login(credential) if credential else None
    if not login or login.lower() != owner.lower():
        raise GhError(f"the agents write as a GitHub App, so an owner answer must be posted with {owner}'s own "
                      f"token in PT_OWNER_TOKEN (found: {login or 'none'}); or answer on GitHub directly "
                      "(reference/identities.md)")
    return credential


def team_logins(repo_name: str) -> set:
    """Logins the team's own comments (decisions, run-log entries) come from: the agents' identity, and the owner's
    login — the agents' identity in same-account mode, and the author of anything written before the app existed."""
    logins = {owner_login(repo_name)}
    login = token_login()
    if login:
        logins.add(login)
    return logins


def owner_login(repo_name: str) -> str:
    return api(f"repos/{repo_name}")["owner"]["login"]
