"""GitHub App identities for the agents (reference/identities.md): the team app writes, the review app gives verdicts.

An app is configured by PT_<KIND>_APP_ID plus its private key, either PT_<KIND>_APP_KEY_FILE (a PEM path) or
PT_<KIND>_APP_KEY (the PEM, raw or base64 — cloud environment variables are single-line). The stdlib has no RSA,
so the app's JWT is signed by the `openssl` CLI. The JWT buys an installation token scoped to the product
repository; tokens are cached per process until shortly before they expire. Key material is never logged, printed
or written to disk (an inline key reaches openssl through a pipe), and child processes never inherit it.
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Optional, Tuple

from . import gh

KINDS = ("team", "review")
# GitHub tolerates little clock drift: backdate iat, and keep exp under the 10-minute maximum.
JWT_BACKDATE = 60
JWT_LIFETIME = 540
# An installation token lives an hour; renew with margin so a long command never holds an expired one.
REFRESH_MARGIN = 300
PIPE_LIMIT = 16384  # smallest default pipe buffer (macOS); an RSA-4096 PEM is ~3.3 KB
_APP_ID = re.compile(r"^(?:\d+|Iv[\w.]+)$")

_tokens: Dict[Tuple[str, str], Tuple[str, float]] = {}
_identities: Dict[str, dict] = {}


class AppError(gh.GhError):
    pass


@dataclass(frozen=True)
class AppConfig:
    kind: str
    app_id: str
    key_file: str = ""
    # repr=False: a traceback or debug print of the config must never show the key.
    key_inline: str = field(default="", repr=False)


def _env(kind: str, name: str) -> str:
    return os.environ.get(f"PT_{kind.upper()}_APP_{name}", "").strip()


def config(kind: str) -> Optional[AppConfig]:
    """The configured app for `kind`, None when its id is unset; a half-configured app is an error, not a fallback."""
    if kind not in KINDS:
        raise ValueError(f"unknown app kind {kind!r}")
    app_id = _env(kind, "ID")
    key_file, key_inline = _env(kind, "KEY_FILE"), os.environ.get(f"PT_{kind.upper()}_APP_KEY", "")
    if not app_id:
        if key_file or key_inline.strip():
            raise AppError(f"PT_{kind.upper()}_APP_KEY is set but PT_{kind.upper()}_APP_ID is not")
        return None
    if not _APP_ID.match(app_id):
        raise AppError(f"PT_{kind.upper()}_APP_ID must be the app's numeric id (App settings → About), got {app_id!r}")
    if not key_file and not key_inline.strip():
        raise AppError(f"PT_{kind.upper()}_APP_ID is set but its key is not: set PT_{kind.upper()}_APP_KEY_FILE "
                       f"(path to the .pem) or PT_{kind.upper()}_APP_KEY (base64 of the .pem)")
    if kind == "review" and _env("team", "ID") == app_id:
        # One app for both roles would let the writing identity approve its own work.
        raise AppError("PT_REVIEW_APP_ID is the team app: the review app must be a separate GitHub App")
    return AppConfig(kind, app_id, key_file, key_inline)


def configured(kind: str) -> bool:
    return config(kind) is not None


def _pem(inline: str, kind: str) -> bytes:
    text = inline.strip()
    if "-----BEGIN" in text:
        # Some env editors keep a pasted PEM on one line with literal "\n".
        return (text.replace("\\n", "\n") + "\n").encode()
    try:
        decoded = base64.b64decode("".join(text.split()), validate=True)
    except (binascii.Error, ValueError):
        decoded = b""
    if b"-----BEGIN" not in decoded:
        raise AppError(f"PT_{kind.upper()}_APP_KEY is neither a PEM private key nor base64 of one "
                       f"(encode it with `base64 < key.pem | tr -d '\\n'`)")
    return decoded


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _openssl_sign(message: bytes, key_path: str, kind: str, pass_fds: Tuple[int, ...] = ()) -> bytes:
    try:
        proc = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key_path], input=message,
                              capture_output=True, check=False, pass_fds=pass_fds, env=gh.child_env())
    except FileNotFoundError as exc:
        raise AppError("the `openssl` command is not installed; it is needed to sign the GitHub App's JWT "
                       "(install OpenSSL or LibreSSL, or unset PT_*_APP_ID to use a token instead)") from exc
    if proc.returncode != 0 or not proc.stdout:
        # openssl's stderr names the failure (bad decrypt, no start line…), never the key itself.
        reason = proc.stderr.decode(errors="replace").strip().splitlines()[:1]
        raise AppError(f"openssl could not sign with the {kind} app's key — is it the app's RSA private key "
                       f"(.pem from App settings → Private keys)? {reason[0] if reason else ''}".rstrip())
    return proc.stdout


def sign(message: bytes, cfg: AppConfig) -> bytes:
    """RS256 signature of `message` with the app's key.

    An inline key never touches the disk: openssl reads it from a pipe (/dev/fd/N) passed to it alone.
    """
    if not cfg.key_inline.strip():
        path = os.path.expanduser(cfg.key_file)
        if not os.path.isfile(path):
            raise AppError(f"PT_{cfg.kind.upper()}_APP_KEY_FILE does not point to a file: {cfg.key_file}")
        return _openssl_sign(message, path, cfg.kind)
    pem = _pem(cfg.key_inline, cfg.kind)
    if len(pem) > PIPE_LIMIT:
        # The whole key is written before openssl starts; beyond one pipe buffer that write would block.
        raise AppError(f"PT_{cfg.kind.upper()}_APP_KEY is too large for a private key ({len(pem)} bytes)")
    read_fd, write_fd = os.pipe()
    try:
        try:
            os.write(write_fd, pem)
        finally:
            os.close(write_fd)
        return _openssl_sign(message, f"/dev/fd/{read_fd}", cfg.kind, pass_fds=(read_fd,))
    finally:
        os.close(read_fd)


def jwt(cfg: AppConfig, now: Optional[float] = None) -> str:
    now = int(time.time() if now is None else now)
    header = {"alg": "RS256", "typ": "JWT"}
    claims = {"iat": now - JWT_BACKDATE, "exp": now + JWT_LIFETIME, "iss": cfg.app_id}
    signing_input = ".".join(_b64url(json.dumps(p, separators=(",", ":")).encode()) for p in (header, claims))
    return f"{signing_input}.{_b64url(sign(signing_input.encode(), cfg))}"


def _explain(exc: gh.GhError, cfg: AppConfig, repo: str, step: str) -> AppError:
    text = str(exc)
    name = f"the {cfg.kind} app (PT_{cfg.kind.upper()}_APP_ID={cfg.app_id})"
    if "HTTP 401" in text:
        return AppError(f"GitHub rejected the JWT of {name} while {step}: the key does not belong to this app id, "
                        "or this machine's clock is off by more than a minute (check `date -u`)")
    if "HTTP 404" in text and step == "finding the installation":
        return AppError(f"{name} is not installed on {repo}: open the app's settings → Install App and install it "
                        "on this repository only (reference/identities.md)")
    if "HTTP 422" in text or "HTTP 403" in text:
        return AppError(f"{name} may not get a token for {repo} while {step}: check that the installation includes "
                        f"this repository and the app's permissions (reference/identities.md). {text}")
    return AppError(f"{name}: {step} failed: {text}")


def _expiry(stamp: str) -> float:
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError) as exc:
        raise AppError(f"unexpected expires_at from GitHub: {stamp!r}") from exc


def installation_token(kind: str, repo: str) -> str:
    """A token of the `kind` app scoped to `repo` (owner/name), minted on first use and reused until near expiry."""
    cfg = config(kind)
    if cfg is None:
        raise AppError(f"no {kind} app configured (PT_{kind.upper()}_APP_ID)")
    cached = _tokens.get((kind, repo))
    if cached and cached[1] - REFRESH_MARGIN > time.time():
        return cached[0]
    bearer = jwt(cfg)
    try:
        installation = gh.api(f"repos/{repo}/installation", auth=bearer)
    except gh.GhError as exc:
        raise _explain(exc, cfg, repo, "finding the installation") from exc
    try:
        minted = gh.api(f"app/installations/{installation['id']}/access_tokens", "POST",
                        {"repositories": [repo.split("/", 1)[1]]}, auth=bearer)
    except gh.GhError as exc:
        raise _explain(exc, cfg, repo, "minting an installation token") from exc
    if not (minted or {}).get("token"):
        raise AppError(f"GitHub returned no installation token for the {kind} app")
    _tokens[(kind, repo)] = (minted["token"], _expiry(minted.get("expires_at", "")))
    return minted["token"]


def identity(kind: str, repo: str) -> dict:
    """{"login": "<slug>[bot]", "id": <bot user id>, "name", "email"} of the `kind` app, for attribution and commits."""
    if kind in _identities:
        return _identities[kind]
    cfg = config(kind)
    if cfg is None:
        raise AppError(f"no {kind} app configured (PT_{kind.upper()}_APP_ID)")
    try:
        slug = (gh.api("app", auth=jwt(cfg)) or {}).get("slug")
    except gh.GhError as exc:
        raise _explain(exc, cfg, repo, "reading the app") from exc
    if not slug:
        raise AppError(f"GitHub did not return a slug for the {kind} app")
    login = f"{slug}[bot]"
    # The bot user's id (not the app id) is what GitHub links a noreply commit email to.
    user = gh.api(f"users/{login}", auth=installation_token(kind, repo)) or {}
    if not user.get("id"):
        raise AppError(f"GitHub has no user {login}")
    _identities[kind] = {"login": login, "id": user["id"], "name": login,
                         "email": f"{user['id']}+{login}@users.noreply.github.com"}
    return _identities[kind]


def reset() -> None:
    """Forget cached tokens and identities (tests; a long-lived process after rotating a key)."""
    _tokens.clear()
    _identities.clear()
