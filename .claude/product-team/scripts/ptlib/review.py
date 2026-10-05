"""The review gate: which independent verdicts a PR needs before it may merge, and whether it has them."""
from __future__ import annotations

import re
from typing import Dict, Iterable, List, Optional, Tuple

ROLES = ("QA", "REVIEW", "SECURITY")
# The whole first line must be the verdict: "QA: APPROVED (conditional on CI)" is not an approval.
_VERDICT = re.compile(r"^\s*(QA|REVIEW|SECURITY):\s*(APPROVED|CHANGES REQUESTED)\s*$", re.IGNORECASE)

# Paths whose change makes a security review mandatory. Broad on purpose: a false positive costs one review,
# a false negative ships an unreviewed auth or payment change.
SENSITIVE = re.compile(
    r"(^|[/_.-])(auth(?![a-z])|oauth|sso|login|session|token(?!s[./])|jwt|password|passwd|credential|secret|"
    r"crypto|encrypt|permission|rbac|acl|roles?(?![a-z])|guard|policy|policies|middleware|cors|csp(?![a-z])|"
    r"security|payment|purchase|billing|checkout|refund|invoice|subscription|wallet|upload|webhook|"
    r"account|user[-_]?data|pii|gdpr|deletion|migrations?(?![a-z])|drizzle|prisma)"
    r"|(^|/)(admin|backoffice)/(?!.*\.(png|svg|ico|jpe?g|webp|css|scss)$)"
    r"|\.controller\.[jt]s$|\.rules$|(^|/)\.env(\.|$)|(^|/)\.gitleaks(ignore|\.toml)$|\.sql$",
    re.IGNORECASE,
)
# Files that steer the agents or the gate itself: a change here is a change to who may merge what.
AGENT_TOOLING = re.compile(
    r"(^|/)\.claude/|^\.product-team/project\.ya?ml$|(^|/)\.mcp\.json$|(^|/)(CLAUDE(\.local)?|AGENTS)\.md$|"
    r"(^|/)CODEOWNERS$",
    re.IGNORECASE,
)
DEPENDENCY_FILES = re.compile(
    r"(^|/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|"
    r"pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(\.lock)?|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|"
    r"Gemfile(\.lock)?|pubspec\.yaml|pubspec\.lock|Podfile(\.lock)?|build\.gradle(\.kts)?|"
    r"settings\.gradle(\.kts)?|gradle\.properties|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$"
    r"|(^|/)\.github/(workflows|actions)/",
    re.IGNORECASE,
)


def security_reasons(paths: Iterable[str], labels: Iterable[str] = ()) -> List[str]:
    reasons = []
    if "security" in set(labels):
        reasons.append("issue labelled security")
    for path in paths:
        if AGENT_TOOLING.search(path):
            reasons.append(f"agent tooling or gate config: {path}")
        elif SENSITIVE.search(path):
            reasons.append(f"sensitive path: {path}")
        elif DEPENDENCY_FILES.search(path):
            reasons.append(f"dependencies or CI: {path}")
    return reasons


PR_FILES_LIMIT = 3000  # GET /pulls/N/files returns at most this many files


def glob_regex(pattern: str) -> "re.Pattern[str]":
    """A path glob as a regex over the whole repo-relative path: `**` crosses directories, `*` and `?` do not,
    a trailing `/` means everything below, and a pattern without `/` matches the file name in any directory.
    Case-insensitive. ValueError for syntax it does not support (`{a,b}`, `[abc]`, `!negation`): silently reading
    them literally would match nothing and drop a required review."""
    pattern = pattern.strip()
    while pattern.startswith("./"):
        pattern = pattern[2:]
    if pattern.startswith("!") or "{" in pattern or "[" in pattern:
        raise ValueError(f"review.code_paths: {pattern!r} is not supported; use plain globs with *, ** and ? "
                         "(one pattern per alternative, no negation)")
    pattern = pattern.lstrip("/")
    if not pattern:
        raise ValueError("review.code_paths has an empty pattern")
    if pattern.endswith("/"):
        pattern += "**"
    if "/" not in pattern:
        pattern = "**/" + pattern
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z", re.DOTALL | re.IGNORECASE)


def code_changes(paths: Iterable[str], code_paths: Iterable[str]) -> List[str]:
    """The changed paths that count as app or library code under `review.code_paths`."""
    patterns = [glob_regex(p) for p in code_paths if p.strip()]
    return [p for p in paths if any(rx.match(p) for rx in patterns)]


def required_verdicts(policy: dict, paths: List[str], security: List[str]) -> Tuple[List[str], Dict[str, dict]]:
    """Which verdicts a PR needs under the base branch's `review:` policy, and why each is or is not required.

    SECURITY is never configurable: `security` is what `security_reasons` found for this PR.
    """
    source = "review" if policy.get("configured") else "default (no review block in project.yml on the base branch)"
    code = code_changes(paths, policy.get("code_paths") or ())
    shown = ", ".join(code[:3]) + (f" (+{len(code) - 3} more)" if len(code) > 3 else "")
    if len(paths) >= PR_FILES_LIMIT:  # GitHub stops listing there: the unlisted rest may be code
        code, shown = code or list(paths), f"GitHub lists only the first {PR_FILES_LIMIT} files"
    required: List[str] = []
    why: Dict[str, dict] = {}
    for role, key in (("QA", "qa"), ("REVIEW", "reviewer")):
        mode = policy.get(key, "always")
        setting = f"{source}: {key}: {mode}"
        if mode == "always":
            needed, reason = True, f"{setting}: needed on every PR"
        elif mode == "never":
            needed, reason = False, f"{setting}: never needed"
        elif code:
            needed, reason = True, f"{setting}: the PR changes code ({shown})"
        else:
            needed = False
            reason = f"{setting}: no changed path matches code_paths ({', '.join(policy.get('code_paths') or [])})"
        if needed:
            required.append(role)
        why[role] = {"required": needed, "why": reason}
    if security:
        required.append("SECURITY")
        why["SECURITY"] = {"required": True, "why": "security-check: " + "; ".join(security[:3]) +
                           (f" (+{len(security) - 3} more)" if len(security) > 3 else "")}
    else:
        why["SECURITY"] = {"required": False, "why": "security-check found no sensitive path, dependency, CI or "
                                                     "security label"}
    return required, why


def verdict(body: str) -> Optional[tuple]:
    m = _VERDICT.match(body or "")
    return (m.group(1).upper(), m.group(2).upper()) if m else None


def latest_verdicts(reviews: List[dict], head_sha: str, reviewers: Iterable[str] = ()) -> Dict[str, dict]:
    """Newest verdict per role; `current` is False when it was given on an older commit than the head.

    Only submitted comment reviews count (a pending draft does not). When `reviewers` is set — the logins of a
    separate reviewing account — verdicts from anyone else are ignored, so a developer cannot approve itself.
    """
    allowed = {r.lower() for r in reviewers}
    found: Dict[str, dict] = {}
    for r in sorted(reviews, key=lambda r: r.get("submitted_at") or ""):
        if r.get("state", "COMMENTED") not in ("COMMENTED", "APPROVED", "CHANGES_REQUESTED"):
            continue
        if allowed and ((r.get("user") or {}).get("login") or "").lower() not in allowed:
            continue
        v = verdict((r.get("body") or "").splitlines()[0] if r.get("body") else "")
        if v:
            found[v[0]] = {"verdict": v[1], "current": r.get("commit_id") == head_sha, "at": r.get("submitted_at")}
    return found


def allowed_reviewers(configured: List[str], review_bot: Optional[str],
                      team_login: Optional[str] = None) -> Tuple[List[str], str]:
    """Logins whose verdicts count, plus a warning ('' when none). ValueError when the team could approve itself.

    With the review app configured its bot is the only reviewer: the key is what makes a verdict independent, so a
    login listed in project.yml never widens it. `team.reviewer_logins` is for sessions without the review app's
    key and for a reviewing machine account. `team_login` is the team app's bot in app mode.
    """
    team = (team_login or "").lower()
    if team and review_bot and review_bot.lower() == team:
        raise ValueError(f"the review app and the team app are the same bot ({review_bot}): verdicts would be "
                         "self-approval; configure a separate review app")
    if team and team in {c.lower() for c in configured}:
        raise ValueError(f"team.reviewer_logins lists the team's own bot {team_login}: the team could approve its "
                         "own work; list only the review app's bot")
    if not review_bot:
        return list(configured), ""
    warning = ""
    if configured and review_bot.lower() not in {c.lower() for c in configured}:
        warning = (f"team.reviewer_logins does not list {review_bot}: sessions without the review app's key will "
                   f"not count its verdicts; add '{review_bot}' there")
    return [review_bot], warning


def unguarded_warning(same_account: bool) -> str:
    """Why a gate with no reviewer restriction is weak — worded for the setup the owner actually has."""
    if same_account:
        return ("same-account mode: the agents act as your GitHub account, so any agent can post a verdict; set up the "
                "review app (reference/identities.md) or team.reviewer_logins (owner checklist)")
    return ("no reviewing identity: the team's own identity can post a verdict that counts; set up the review app "
            "(reference/identities.md) and list its '<slug>[bot]' login in team.reviewer_logins")


def gate(reviews: List[dict], head_sha: str, security_required: bool, reviewers: Iterable[str] = (),
         roles: Iterable[str] = ("QA", "REVIEW")) -> dict:
    """roles: the verdicts required besides SECURITY (required_verdicts); QA and REVIEW unless a policy says less."""
    required = [r for r in roles if r != "SECURITY"] + (["SECURITY"] if security_required else [])
    verdicts = latest_verdicts(reviews, head_sha, reviewers)
    missing = []
    for role in required:
        v = verdicts.get(role)
        if not v:
            missing.append(f"{role}: no verdict")
        elif v["verdict"] != "APPROVED":
            missing.append(f"{role}: changes requested")
        elif not v["current"]:
            missing.append(f"{role}: approved an older commit")
    return {"required": required, "verdicts": verdicts, "missing": missing, "passed": not missing}


BRANCH_OPERATIONS = {("dev", "stage"), ("stage", "main"), ("stage", "dev"), ("main", "stage"), ("main", "dev")}


def ci_only_allowed(head: str, base: str, files: List[str]) -> str:
    """'' when a merge may skip the verdicts, else the reason it may not.

    Allowed: the fixed branch operations of the release flow (cut, release, back-merges), and the plugin's
    self-update PR into dev when every changed file is generated team tooling under .claude/.
    """
    if (head, base) in BRANCH_OPERATIONS:
        return ""
    if head.startswith("chore/product-team-"):
        if base != "dev":
            return "the self-update PR must target dev"
        outside = [f for f in files if not f.startswith(".claude/")]
        return f"the self-update PR changes files outside .claude/: {outside[:3]}" if outside else ""
    return f"{head} → {base} is not a branch operation"
