# Decision policy — who decides what

The owner is the client, reachable on a phone, with limited attention. Every question to the owner costs a day and
a context switch, so the team asks only what nobody else may decide. Enforced by `scripts/backlog create --kind
question`: it requires one of the categories below and an answer line, or refuses.

## The owner decides

| Category (`--owner-category`) | Examples |
| ---- | ---- |
| `money` | any spend: a paid plan or upgrade, a domain, a paid API, a store developer account |
| `scope` | adding, dropping or reshaping a feature; what ships in a sprint when it must be cut |
| `release` | release go / no-go; overriding a release blocker |
| `access` | accounts, secrets, permissions and settings only the owner can create or grant |
| `legal` | terms, privacy, licences, anything with legal exposure |
| `design` | approving a design, a visual direction or a signature moment |

## The team decides — and records it

Everything else: technical choices (libraries, identifiers such as a bundle id, key layout, naming, structure,
data model within the approved scope), order of work inside the sprint, how to fix a finding, test strategy,
which free-tier service to propose first. Decide with the owner's interests in mind (the $0 budget, reversibility,
the stack decision), then record it:

- small: `backlog decide N --body-file <why>` on the issue it belongs to (label `team-decided`, listed in the owner's
  daily digest as FYI; the owner reverses it with `/reject why`);
- significant or hard to reverse: a decision record in the project's `decisions_dir`, linked from the issue.

When unsure whether something is the owner's: if it costs money, changes what users get, or needs the owner's
own account — ask. Otherwise decide.

## Asking vs. asking the owner to do something

A **question** asks the owner to decide (answered with approve / reject, go / no-go). A **task only the owner can
do** — create an account, put a secret in place, run something on their machine — is not a question: create it as
`--kind chore` with `needs:owner` (or `needs:local`), a short checklist in the body, and it is answered with "done".
Setting up the team's GitHub Apps (`reference/identities.md`) is such a task; the team never holds or asks for
their private keys.
Mixing the two gives the owner the wrong buttons.

## How to ask

`backlog create --kind question --owner-category <c> --ask "<one line>" --title … --body-file …`

- The **ask line** is what the owner reads first, in the owner's language (`owner.language`), and names the
  command that answers it: "`/approve` to use Cloudflare R2 (free, recommended) · `/reject why` to keep SeaweedFS".
- Put the recommendation first; the body holds the options, costs and consequences — short.
- One decision per question. Never ask for a secret value; ask the owner to put it in GitHub Secrets.
