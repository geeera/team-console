# 0005 — Owner requests to the PM: one comment format, the console never applies them

Status: accepted (owner decision in chat, 2026-10-01, recorded on #112 cut C and #107: «Пусть будет просьба, PM
учитывает»; the format below is a team decision under `reference/decision-policy.md`). Date: 2026-10-05, amended
the same day after the SECURITY review of PR #216 (provenance of the request and of the handled marker, the #107
surface, exact marker matching, the rebuild rule). Extends [ADR 0001](0001-stack-and-architecture.md) decision 9
(the owner grammar) and decision 12 (plugin dependencies raised as separate changes). Number 0004 is reserved by
ADR 0003 for the read-cache amendment.

## Context

Two console features let the owner ask the team's PM for something the console must not do itself: #107 (a new
task with a sprint wish) and #29 (move an existing issue to another sprint, move it up or down the queue). The
owner decided that these are **requests the PM honours**, not console writes: the console never sets a
milestone, a status or a team label (plan #112 cut C). The plugin's owner grammar (ADR 0001 decision 9) has no
command for them, and an owner command must never be invented for this: `commands.parse` would read it as an
instruction, and the PM is the one who decides whether a sprint has room.

The plugin (product-team 0.10.3) has **no reader for such a request today**: `ptlib/commands.py` knows the owner
commands only, `slot-pm` and `pm` do not look for a request marker. A request is therefore visible to the PM as
text on the issue (the PM reads issues through `backlog show`) but nothing guarantees it is acted on.

What "the owner wrote it" can and cannot prove (plugin 0.10.3, `ptlib/commands.py`, `provenance.py`, `gh.py`):
an owner-authored, unedited comment is **not** proof when `gh.acts_as_owner` is true — in same-account mode, and in
app mode whenever an owner credential is in the agents' session — because an agent (a prompt-injected one is
enough) can post with the owner's credential. `commands.py` skips `<!-- pt-` comments for exactly that reason. The
one signal that tells the console's write apart from an agent holding the owner's credential is
`performed_via_github_app`: a comment posted with the console app's user-to-server token (`ghu_`) is expected to
carry the app, while the owner's `gh` OAuth token and a PAT carry none (ADR 0003 decision 1 relies on the same
field for the fixture label). An issue **body** can be verified only through GraphQL edit history
(`provenance.body_statement`); in REST-only mode (cloud sessions) a body is never trusted, and the PM edits bodies
while grooming, so a request in a body would be silently dropped.

## Decisions

| # | Decision | Why | Rejected |
| - | -------- | --- | -------- |
| 1 | **One format for every owner request, shared by #107 and #29**, written in `libs/shared/owner-grammar` next to `answerComment` as `requestComment`. A request is **one issue comment** — on the existing issue (#29) or, for an issue the console creates (#107), the **first comment** posted right after the issue, on the owner token: line 1 is exactly the marker `<!-- pt-owner-request {"kind":"sprint","target":"next","v":1} -->` (JSON with sorted keys, one line, no whitespace), then one human line in the project's `owner.language`, then the italic trailer `_Requested by the owner in the team console: «words»_`. `kind` ∈ `sprint` (`target` ∈ `current` \| `next` \| `backlog`) \| `priority` (`direction` ∈ `up` \| `down`). The owner's words are collapsed to one line like an answer's. **Parsers anchor on the whole first line** (`^<!-- pt-owner-request \{…\} -->$`), never on a prefix: `<!-- pt-owner-request` is a prefix of `<!-- pt-owner-request-handled`, and a fixture feeds a handled marker to `requestMarkerOf` and expects `null`. Golden fixtures pin the bytes. | The `<!-- pt-` prefix is what the plugin's command parser treats as a script marker (`SCRIPT_MARKER`): the request can never be read as an owner command, and the human line is readable in the issue. One comment surface means one reader with one provenance rule for both features; a comment's edit state is visible through REST (`updated_at`), a body's is not. | A label such as `owner-request:next` (a team label the console must not set; no words, no audit line); an owner command (`/sprint next`) — would need `commands.py` to grow a command whose effect the PM may refuse; **a block in the issue body** (#107's first draft) — unverifiable without GraphQL, rewritable by every Issues-write holder, and lost at the PM's first grooming edit. |
| 2 | **Written with the owner's own token** through the owner-write path (ADR 0003 decision 2(b): `ownerWriter`, the owner check, 60 s replay from `own_writes` with `kind = 'request'`). The service identity is refused outright (`owner-only`, #62). **A reader — the plugin's `slot-pm`, the console's rebuild, anything — honours a request only when all of these hold:** (a) the comment's author is the repository owner (`owner.login`); (b) the comment is unedited: `provenance.screen` where GraphQL exists, `updated_at == created_at` in REST-only mode; (c) the comment's `performed_via_github_app` is the console app of that environment (`team-console-<env>`), named in configuration — the plugin's `team.console_app_slugs` in `project.yml` (one per environment that writes to this repository), never a login. Rule (c) is what separates the console's write from an agent holding the owner's credential; (a) and (b) alone are the rule for owner *commands* and are not enough here. **Verification owed by slice 2 of #29**: post one request against the real stage app and assert that the comment carries `performed_via_github_app` with the app's slug. **If GitHub does not set the field for a user-to-server comment, rule (c) is replaced by: a request is never honoured when `gh.acts_as_owner` is true** (the plugin's own `<!-- pt-` rule), and the console's copy says that requests work only with the team's GitHub App configured. A fixture pins the negative: an owner-authored, unedited marker **without** `performed_via_github_app` is ignored. | Attribution is the whole point: a request from a bot, or from an agent echoing issue text with the owner's credential, is not the owner's wish. | A request posted by the console's app identity; trusting owner authorship alone. |
| 3 | **The console shows "waiting for the PM" from its own record, not from GitHub reads.** D1 table `owner_requests` (`slug`, `issue_number`, `comment_id`, `kind`, `payload`, `requested_at`, `handled_comment_id NULL`, `result NULL`, `handled_at NULL`), written when the console posts the request. **The handled marker** `<!-- pt-owner-request-handled {"comment_id":N,"result":"applied","v":1} -->` counts only when **all** hold: it is the **first line** of the comment (never a substring — a quote in prose does nothing); the event is `issue_comment.created` (the `hooks` Worker) or the request form's re-read of the issue's last comment page when it opens (1–2 subrequests, for a missed delivery); the author is the PM's identity — a `type: Bot` login in `TRUSTED_BOT_LOGINS` (the team's app), **or**, in same-account mode, the owner login, recorded here as a known residual (an agent with the owner's credential can mark a request handled; it cannot apply or write anything through it); the JSON parses strictly — integer `comment_id`, `result` ∈ {`applied`, `declined`}, `v === 1`, nothing else; `comment_id` equals the `comment_id` of an existing row for the **same repository and issue number**; the handled comment's `created_at` is after that row's `requested_at`; and, on the form's re-read, the handled comment is unedited (`updated_at == created_at`), so an edited "declined" never becomes "applied". Anything else is ignored. The newest request on an issue replaces the older one. **The table is a rebuildable index of GitHub comments, never a second source of truth: a rebuild applies decision 2 (a)–(c) to every candidate comment, and a row never drives a GitHub write or an authorisation decision** — it only colours a board row and prefills a form. | The board marks every row; one comments read per issue per board load would cost more subrequests than the board has. `isTrustedAuthor` (OWNER/MEMBER/COLLABORATOR) is the rule for *notifying*, too wide for *handled*: a collaborator must not be able to tell the owner the PM acted. | Reading each issue's comments on every board load; a label the PM removes (a team label, and the console must not depend on one it cannot set); `isTrustedAuthor` for the marker. |
| 4 | **Plugin dependency, raised as a separate change in `product-team`** (as ADR 0001 decision 12 does for the chat): `slot-pm` reads `pt-owner-request` first-line markers on issue comments with the provenance of decision 2 (owner author, unedited, `performed_via_github_app` ∈ `team.console_app_slugs`; or the `acts_as_owner` fallback), applies them within the sprint caps and outside freeze days or says why not, and answers with the `pt-owner-request-handled` marker on the first line of its own comment, its `comment_id` naming the request, and a reason in prose. Until it ships the console records the request and says exactly that: "the PM reads it at the next planning run" — the honesty rule of #107. | The console must not invent behaviour the team does not have; the reader belongs with the parser. | A console-side cron that nags; applying the milestone from the console (the owner decided against it). |

## Consequences

- #29: the request route, the `owner_requests` table (next free migration number when its PR opens), the hooks
  handled-marker mapping (with its own author rule, not `isTrustedAuthor`) and the board's request state follow
  this ADR; the architect note on #29 has the routes. Slice 2 owes the `performed_via_github_app` check against
  the stage app before the plugin reader is written.
- #107: the issue is created, then the request is posted as its **first comment** with the same `requestComment`
  on the owner token (one more subrequest, one verifiable surface); no body block, no second format.
- `@shared/owner-grammar`: `requestComment` + `requestMarkerOf` / `handledMarkerOf` (strict, first-line, exact
  token) + fixtures: every kind/target/direction in ru and en; a handled marker given to `requestMarkerOf` → `null`;
  a request marker given to `handledMarkerOf` → `null`; an owner-authored marker without `performed_via_github_app`
  → ignored by the provenance check. The `v` field lets the plugin reject a shape it does not know.
- `.product-team/project.yml`: `team.console_app_slugs` (the plugin reads it; the console's own copy lists its
  three environment apps).
- Plugin roadmap item: the `slot-pm` reader of decision 4, written against the fixtures in this repository.
