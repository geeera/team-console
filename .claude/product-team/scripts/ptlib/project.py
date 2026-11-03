"""Minimal readers for .product-team/project.yml (stdlib only: no YAML parser is guaranteed in cloud sessions)."""
from __future__ import annotations

import re

PROJECT_FILE = ".product-team/project.yml"
# A user login, or a GitHub App's bot login (`<app-slug>[bot]`).
_LOGIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$")
# A GitHub App's slug as REST reports it in `performed_via_github_app.slug`.
_SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")


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
    return _list_from_text(text, "reviewer_logins", _LOGIN, "`[a, 'app-name[bot]']` or `- a` lines of GitHub logins")


def console_app_slugs_from_text(text: str) -> list:
    """`team.console_app_slugs: [team-console-prod, …]` — the team console's GitHub Apps (one per environment that
    writes to this repository). An owner request counts only when GitHub says one of them posted it
    (`performed_via_github_app.slug`; geeera/team-console ADR 0005). App slugs, never bot logins."""
    return _list_from_text(text, "console_app_slugs", _SLUG, "`[team-console-prod]` or `- slug` lines of GitHub "
                           "App slugs (not `[bot]` logins)")


def text_on_branch(repo: str, branch: str) -> str:
    """project.yml as `branch` has it on GitHub ("" when it has none). Trust settings are read from there, never
    from the working tree, which may be any branch an agent checked out or edited."""
    from urllib.parse import quote

    from . import gh  # local import: the readers above stay free of network access
    try:
        # A full ref: a tag or commit named like the branch must never stand in for it.
        return gh.raw(f"repos/{repo}/contents/{PROJECT_FILE}?ref={quote('refs/heads/' + branch, safe='/')}",
                      "application/vnd.github.raw")
    except gh.GhError as exc:
        if "HTTP 404" in str(exc):
            return ""
        raise


def console_app_slugs_on_default_branch(repo: str) -> list:
    """console_app_slugs as the repository's default branch has it: changing the trust root takes a merged PR."""
    from . import gh
    return console_app_slugs_from_text(text_on_branch(repo, gh.api(f"repos/{repo}")["default_branch"]))


def _list_from_text(text: str, key: str, item: "re.Pattern[str]", hint: str) -> list:
    """`key: [a, b]`, `key: a, b` or `- a` lines under an empty `key:`; [] when the key is absent."""
    m = re.search(r"^([ \t]*)%s:[ \t]*(.*)$" % re.escape(key), text, re.MULTILINE)
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
            entry = re.match(r"^[ \t]+-[ \t]*([^#]*)", line)
            if not entry:
                break
            items.append(entry.group(1))
    values = [x.strip().strip("'\"") for x in items if x.strip().strip("'\"")]
    unreadable = not values and inline.replace(" ", "") != "[]"
    # Present but unreadable: an empty or mangled list would silently trust the wrong account.
    if unreadable or any(not item.match(v) for v in values):
        raise ValueError(f"team.{key} is set but could not be read; use {hint}")
    return values


def run_log_issue(path: str = PROJECT_FILE) -> int:
    """`team.run_log_issue` — the number of the run-log issue, 0 when not pinned."""
    try:
        with open(path, encoding="utf-8") as f:
            m = re.search(r"^\s*run_log_issue:\s*(\d+)\s*(?:#.*)?$", f.read(), re.MULTILINE)
    except FileNotFoundError:
        return 0
    return int(m.group(1)) if m else 0


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


REVIEW_MODES = ("always", "code", "never")
# `code` without `code_paths`: the usual source roots plus source, build and style files anywhere. Broad on purpose:
# a false positive costs one review, a false negative merges unreviewed code. Matched case-insensitively.
DEFAULT_CODE_PATHS = (
    "apps/**", "libs/**", "packages/**", "src/**", "lib/**", "app/**", "server/**", "client/**", "services/**",
    "api/**", "*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.vue", "*.svelte*", "*.astro",
    "*.html", "*.css", "*.scss", "*.py", "*.go", "*.rs", "*.java", "*.kt", "*.kts", "*.swift", "*.m", "*.dart",
    "*.rb", "*.php", "*.cs", "*.c", "*.cc", "*.cpp", "*.h", "*.sql", "*.sh", "*.tf", "Makefile", "*.config.*",
    "tsconfig*.json",
)
_REVIEW_KEYS = ("qa", "reviewer", "code_paths", "max_rework_rounds")


def default_review_policy() -> dict:
    """No `review:` block: QA and REVIEW on every PR, as before 0.10.2, so existing products do not change silently."""
    return {"configured": False, "qa": "always", "reviewer": "always", "code_paths": list(DEFAULT_CODE_PATHS),
            "max_rework_rounds": 1}


def _split_outside_quotes(raw: str, what: str) -> tuple:
    """(value without its trailing ` # comment`, the value's top-level comma positions). A `#` inside quotes is
    text; an unclosed quote raises."""
    quote, commas = "", []
    for i, ch in enumerate(raw):
        if quote:
            if ch == quote:
                quote = ""
        elif ch in "'\"":
            quote = ch
        elif ch == "#" and (i == 0 or raw[i - 1] in " \t"):
            return raw[:i].rstrip(), commas
        elif ch == ",":
            commas.append(i)
    if quote:
        raise ValueError(f"review.{what} has an unclosed quote: {raw.strip()!r}")
    return raw.rstrip(), commas


def _unquote(item: str, what: str) -> str:
    item = item.strip()
    if item[:1] in ("'", '"'):
        if len(item) < 2 or item[-1] != item[0]:
            raise ValueError(f"review.{what}: cannot read {item!r}")
        return item[1:-1]
    return item


def _scalar(raw: str, what: str) -> str:
    value, _ = _split_outside_quotes(raw, what)
    return _unquote(value, what) if value.strip() else ""


def _glob_list(inline: str, following: list) -> list:
    """An inline `["a", b]` list, or `- a` lines under an empty `key:`."""
    value, _ = _split_outside_quotes(inline, "code_paths")
    value = value.strip()
    if value:
        if not (value.startswith("[") and value.endswith("]")):
            raise ValueError(f"review.code_paths must be a list like [\"apps/**\", \"libs/**\"], got {value!r}")
        body = value[1:-1]
        _, commas = _split_outside_quotes(body, "code_paths")
        bounds = [-1] + commas + [len(body)]
        items = [body[a + 1:b] for a, b in zip(bounds, bounds[1:])]
        return [x for x in (_unquote(i, "code_paths") for i in items if i.strip()) if x]
    items = []
    for line in following:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^[ \t]+-[ \t]*(.*)$", line)
        if not m:
            break
        items.append(_scalar(m.group(1), "code_paths"))
    return [x for x in items if x]


def review_policy_from_text(text: str) -> dict:
    """The top-level `review:` block of a project.yml given as text: which verdicts a PR needs besides SECURITY.

    ValueError when the block is present but cannot be read unambiguously (a bad value, an unsupported glob, a
    second `review:` block): guessing could drop a required verdict.
    """
    from . import review  # glob syntax lives with the matcher

    lines = (text or "").splitlines()
    starts = [i for i, line in enumerate(lines) if re.match(r"^review:[ \t]*(#.*)?$", line)]
    policy = default_review_policy()
    if not starts:
        return policy
    if len(starts) > 1 or any(re.match(r"^review:", line) for i, line in enumerate(lines) if i not in starts):
        raise ValueError("project.yml has more than one top-level `review:` key (or one with an inline value); "
                         "keep a single block")
    block = []
    for line in lines[starts[0] + 1:]:
        if line.strip() and not line[0].isspace() and not line.startswith("#"):
            break
        block.append(line)
    policy["configured"] = True
    seen = set()
    for i, line in enumerate(block):
        m = re.match(r"^[ \t]+([A-Za-z_]+):[ \t]*(.*)$", line)
        if not m:
            continue
        key, value = m.group(1), m.group(2)
        if key not in _REVIEW_KEYS:
            raise ValueError(f"review.{key} is not a known setting (known: {', '.join(_REVIEW_KEYS)})")
        if key in seen:
            raise ValueError(f"review.{key} is set twice")
        seen.add(key)
        if key in ("qa", "reviewer"):
            mode = _scalar(value, key)
            if mode not in REVIEW_MODES:
                raise ValueError(f"review.{key} must be one of {', '.join(REVIEW_MODES)}, not {mode!r}")
            policy[key] = mode
        elif key == "code_paths":
            paths = _glob_list(value, block[i + 1:])
            if not paths:
                raise ValueError("review.code_paths is set but empty or unreadable; list globs such as "
                                 "[\"apps/**\", \"libs/**\"]")
            for path in paths:
                review.glob_regex(path)  # raises for syntax the matcher does not support
            policy[key] = paths
        else:
            number = _scalar(value, key)
            if not number.isdigit():
                raise ValueError(f"review.max_rework_rounds must be a whole number, not {number!r}")
            policy[key] = int(number)
    return policy


def review_policy(path: str = PROJECT_FILE) -> dict:
    """review_policy_from_text() of the working tree's project.yml (guidance only: the gate reads the base branch)."""
    try:
        with open(path, encoding="utf-8") as f:
            return review_policy_from_text(f.read())
    except FileNotFoundError:
        return default_review_policy()
