# 0005 — Owner requests to the PM: one comment format, the console never applies them

Status: accepted (owner decision in chat, 2026-10-01, recorded on #112 cut C and #107: «Пусть будет просьба, PM
учитывает»; the format below is a team decision under `reference/decision-policy.md`). Date: 2026-10-05.
Extends [ADR 0001](0001-stack-and-architecture.md) decision 9 (the owner grammar) and decision 12 (plugin
dependencies raised as separate changes). Number 0004 is reserved by ADR 0003 for the read-cache amendment.

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

## Decisions

| # | Decision | Why | Rejected |
| - | -------- | --- | -------- |
| 1 | **One format for every owner request, shared by #107 and #29**, written in `libs/shared/owner-grammar` next to `answerComment` as `requestComment`. A request is one GitHub comment (an issue that exists) or one block at the end of the issue body (an issue the console creates, #107): the marker line `<!-- pt-owner-request {"kind":"sprint","target":"next","v":1} -->` (JSON, sorted keys, one line, no whitespace), then one human line in the project's `owner.language`, then the italic trailer `_Requested by the owner in the team console: «words»_`. `kind` ∈ `sprint` (`target` ∈ `current` \| `next` \| `backlog`) \| `priority` (`direction` ∈ `up` \| `down`). The owner's words are collapsed to one line like an answer's. Golden fixtures pin the bytes. | The `<!-- pt-` prefix is what the plugin's command parser treats as a script marker (`SCRIPT_MARKER`): the request can never be read as an owner command, and the human line is readable in the issue. One format means the plugin learns one reader for both features. | A label such as `owner-request:next` (a team label the console must not set; a label carries no words and no audit line); an owner command (`/sprint next`) — would need `commands.py` to grow a command whose effect the PM may refuse. |
| 2 | **Written with the owner's own token** through the owner-write path (ADR 0003 decision 2(b): `ownerWriter`, the owner check, 60 s replay from `own_writes` with `kind = 'request'`). The service identity is refused outright (`owner-only`, #62). The plugin honours a request **only when the comment's author is the repository owner and nobody edited it** — the same provenance rule it applies to owner commands. | Attribution is the whole point: a request from a bot is not the owner's wish. | A request posted by the console's app identity. |
| 3 | **The console shows "waiting for the PM" from its own record, not from GitHub reads.** D1 table `owner_requests` (`slug`, `issue_number`, `comment_id`, `kind`, `payload`, `requested_at`, `handled_comment_id NULL`, `result NULL`, `handled_at NULL`), written when the request is posted. A request is **pending** until a comment by a trusted team author carries `<!-- pt-owner-request-handled {"comment_id":N,"result":"applied"\|"declined","v":1} -->` naming it: the `hooks` Worker marks the row on `issue_comment.created`, and the request form re-reads the issue's last comment page when it opens (one or two subrequests) in case a delivery was missed. The newest request on an issue replaces the older one; the table is a rebuildable index of GitHub comments, never a second source of truth. | The board marks every row; one comments read per issue per board load would cost more subrequests than the board has. The row is derived from GitHub and can be dropped and rebuilt. | Reading each issue's comments on every board load; a label the PM removes (a team label, and the console must not depend on one it cannot set). |
| 4 | **Plugin dependency, raised as a separate change in `product-team`** (as ADR 0001 decision 12 does for the chat): `slot-pm` reads `pt-owner-request` comments and body blocks by the owner, applies them within the sprint caps and outside freeze days or says why not, and answers with the `pt-owner-request-handled` marker and a reason. Until it ships the console records the request and says exactly that: "the PM reads it at the next planning run" — the honesty rule of #107. | The console must not invent behaviour the team does not have; the reader belongs with the parser. | A console-side cron that nags; applying the milestone from the console (the owner decided against it). |

## Consequences

- #29: the request route, the `owner_requests` table (next free migration number when its PR opens), the hooks
  handled-marker mapping and the board's request state follow this ADR; the architect note on #29 has the routes.
- #107: the body block variant of decision 1 (the console writes it into the new issue's body, after the
  plugin's `backlog create` body); no second format.
- `@shared/owner-grammar`: `requestComment` + `requestMarkerOf` (parse) + fixtures; the `v` field lets the plugin
  reject a shape it does not know.
- Plugin roadmap item: the `slot-pm` reader of decision 4, written against the fixtures in this repository.
