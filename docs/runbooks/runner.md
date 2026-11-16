# Runner — install, enrol, the runner key, credentials, pause, update, revoke and the manual isolation check

The runner runs on the customer's machine and claims jobs from the console. It runs each job as a separate
locked-down user (`user` backend, macOS) or in its own container (`container` backend). `none` is for local
fixtures only. Decisions referenced are those of the architect note on #468 (ADR 0008); threat-model rows are from
`docs/security/`. Commands below use `<v>` for a release version (`0.1.0`) and `<platform>` for one of
`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`.

## Get a release and verify it (both backends)

Releases are built only by `.github/workflows/release-runner.yml` from a `v*` tag, which only the owner can create
(threat model C11 rows 1–2). Each release has one tarball per platform. Every tarball holds the same JavaScript:
`team-console-runner.mjs`, `bin/job-exec`, the `bin/team-console-runner` launcher and a `SHA256SUMS` of those three
files. The release also has a `SHA256SUMS` of the tarballs and a build-provenance attestation for each tarball. There
is no `curl | sh` path. Download, verify, and only then extract.

You need the GitHub CLI (`gh`, https://cli.github.com) and `gh auth login` once. `gh attestation verify` reads the
attestation through the GitHub API.

```sh
gh release download v<v> --repo geeera/team-console \
  --pattern 'team-console-runner-<v>-<platform>.tar.gz' --pattern SHA256SUMS
gh attestation verify team-console-runner-<v>-<platform>.tar.gz --repo geeera/team-console \
  --signer-workflow github.com/geeera/team-console/.github/workflows/release-runner.yml \
  --source-ref refs/tags/v<v> --deny-self-hosted-runners
grep ' team-console-runner-<v>-<platform>.tar.gz$' SHA256SUMS | shasum -a 256 -c
```

Do not go on unless `gh attestation verify` prints `✓ Verification succeeded!`. A failure means the file was not
built by that workflow from that tag. Delete the file and report it.

Extract the tarball into a root-owned directory. The default is `/usr/local/lib/team-console-runner`. The tarball is
flat, so it extracts straight into that directory:

```sh
sudo install -d -o root -m 0755 /usr/local/lib/team-console-runner
sudo tar -xzf team-console-runner-<v>-<platform>.tar.gz --no-same-owner -C /usr/local/lib/team-console-runner
/usr/local/lib/team-console-runner/bin/team-console-runner version    # prints <v>
```

`install --backend user` refuses a directory, bundle or `job-exec` that is not root-owned or that anyone else can
write, because the sudoers rule names that file. Run `install --dry-run` first. It lists every step and changes
nothing. Then run the same command with `--yes`. Run the launcher by its full path, or put
`/usr/local/lib/team-console-runner/bin` on `PATH`. Do not symlink the launcher elsewhere, because it finds the bundle
relative to its own path.

### The container image

The release notes name the image by digest: `ghcr.io/geeera/team-console-runner:<v>@sha256:<digest>`. Always use
the digest. The runner refuses an image that is not pinned by one. The image is signed with cosign keyless and
carries a build-provenance attestation from the same workflow. Verify either one:

```sh
cosign verify ghcr.io/geeera/team-console-runner@sha256:<digest> \
  --certificate-identity https://github.com/geeera/team-console/.github/workflows/release-runner.yml@refs/tags/v<v> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/geeera/team-console-runner@sha256:<digest> --repo geeera/team-console \
  --signer-workflow github.com/geeera/team-console/.github/workflows/release-runner.yml
```

## `user` backend (macOS) — the owner's Mac (#576)

`sudo` may not search Homebrew's `PATH`, so name `node` and the bundle explicitly:

```sh
NODE=$(command -v node); B=/usr/local/lib/team-console-runner/team-console-runner.mjs
sudo "$NODE" "$B" install --backend user --dry-run
sudo "$NODE" "$B" install --backend user --yes
```

What `--yes` does. It writes only these paths (decision 11, threat model C11):

- It creates the group `_tcjob`. It creates the users `_tcjob` (home `/var/empty`, which is root-owned) and
  `_tcrunner` (home = `TC_RUNNER_HOME`, default `/Users/_tcrunner`, primary group `_tcjob`). Both are hidden, have
  shell `/usr/bin/false` and no password. An existing user is kept, but the installer refuses one that is in `admin`.
- It creates `TC_RUNNER_HOME` as `_tcrunner:_tcjob 0710`, with `credentials/` and `logs/` at 0700. A job can only
  pass through the home to `jobs/`, `work/` and `plugin/`; it cannot list it (#599). The runner refuses to start a job
  when the home has any other mode. A home that an older release made 0750 is narrowed the next time you run
  `install --yes`. The installer refuses to go on when the home, `credentials` or `logs` is a symlink or a file, and
  it never sets a mode through a link (#598).
- It writes `/Library/Application Support/ClaudeCode/managed-settings.json` as `root:wheel 0644`. All hooks are off,
  and the runner refuses to start a job when this file is not root-owned or has changed.
- It writes `/etc/sudoers.d/team-console-runner` as `0440`, checked with `visudo -c` first. It holds one rule:
  `_tcrunner ALL=(_tcjob) NOPASSWD: <prefix>/bin/job-exec`.
- It writes `/Library/LaunchDaemons/com.team-console.runner.plist`, which runs `run --loop` as `_tcrunner` with
  umask 027.

Then do these steps by hand. The installer never handles a code or a credential.

1. Enrol. Create a one-time code on Settings › Runners, then run:
   `sudo -u _tcrunner env HOME=/Users/_tcrunner TC_RUNNER_HOME=/Users/_tcrunner "$NODE" "$B" enrol --url <console> --backend user --credential setup-token --code -`.
   It asks for the code; paste it and press Enter. The code is valid for 10 minutes and works once. See
   [The one-time code](#the-one-time-code) for why it is not an argument.
2. Credential. Run `sudo -u _tcrunner sh -c 'umask 077; HOME=/Users/_tcrunner exec claude setup-token'`. Then store
   the token it prints with `sudo -u _tcrunner sh -c 'umask 077; cat > /Users/_tcrunner/credentials/claude-setup-token'`
   (paste the token, then Ctrl-D).
3. Start: `sudo launchctl bootstrap system /Library/LaunchDaemons/com.team-console.runner.plist`. The runner logs to
   `/Users/_tcrunner/logs/runner.log`.

The toolchain the jobs use (`config.toolchain.path`, Homebrew's `node`, `git`, `claude`) must be readable and
executable by `_tcjob`.

## `container` backend (Linux, or Docker/OrbStack on a Mac)

```sh
R=<prefix>/bin/team-console-runner
"$R" install --backend container --image ghcr.io/geeera/team-console-runner:<v>@sha256:<digest> --dry-run
"$R" install --backend container --image ghcr.io/geeera/team-console-runner:<v>@sha256:<digest> --yes
```

Run these as the user the runner runs as, **not** with sudo. The installer pulls the image by digest. It creates
`TC_RUNNER_HOME` at 0700. It writes a systemd user unit (`~/.config/systemd/user/team-console-runner.service`) or a
LaunchAgent (`~/Library/LaunchAgents/com.team-console.runner.plist`). Then enrol with `TC_ENROL_CODE=<tce_…> "$R" enrol
--url <console> --backend container --image <same ref> --credential api-key|claude-config-dir [--claude-config-dir
<dir>]` (or `--code -` to paste the code at a prompt; see [The one-time code](#the-one-time-code)).

Each job runs in its own `--rm` container from that image:

- The root filesystem is read-only, every capability is dropped and `no-new-privileges` is set.
- `HOME`, `TMPDIR` and `/tmp` are on tmpfs.
- The clone is the only writable mount. The socket directory, the plugin, the managed settings and a
  `claude-config-dir` are mounted read-only. `TC_RUNNER_HOME` is never mounted.
- The job's environment reaches it on stdin, never as `-e`.

## The one-time code (#582)

`enrol` reads the code from one of three places. Never pass it as an argument on a shared host:

- `TC_ENROL_CODE=<tce_…> team-console-runner enrol --url <console> --backend …` is the command Settings › Runners
  shows. The variable is in the process's environment, which only its own user and root can read.
- `--code -` reads one line of stdin. On a terminal it prompts first. Use it under `sudo`, which drops the caller's
  environment, or pipe the code in from a file: `… enrol … --code - < code.txt`.
- `--code <tce_…>` still works, for scripts and fixtures. Any local user can read an argument with `ps` while enrol
  runs, up to its 30 s timeout. Someone who races the request can enrol their own key with your code.

Giving both `--code` and `TC_ENROL_CODE` is a usage error. The command never prints the code. A typed or pasted code
stays in your shell history, but it is spent by then.

## Where the runner key is kept (#585)

`enrol` generates the runner's Ed25519 key on the host. The console gets only the public half. The private half
signs every runner JWT, and with Access optional it is the runner's whole identity (threat model C4 row 1). It lives
in one of two stores:

| Host | Store | What protects it |
| --- | --- | --- |
| macOS, and the runner's user has a default keychain (a user who logs in: `container` or `none` on a Mac) | A generic-password item in that keychain: service `team-console-runner`, account `runner-key:<real path of TC_RUNNER_HOME>` (symlinks resolved), the key as base64 PKCS#8. No key file is written. | The keychain is encrypted at rest under the user's login password, so a copy or backup of the home holds no key. The item trusts only `/usr/bin/security`, the runner's reader. Any process of the same user can still run `security` while the keychain is unlocked, so the user boundary is what keeps jobs out. |
| Linux and the container host, and macOS users with no keychain, such as the `user` backend's `_tcrunner` | `TC_RUNNER_HOME/keys/runner.key`, 0600, in a 0700 `keys/` owned by the runner's user | The runner refuses a key file that is not a regular file of its own user, or that group or others can read. |

`_tcrunner` is a LaunchDaemon user that never logs in, so it has no login keychain. A keychain the runner created for
it would need a password to unlock at boot, and that password would sit on the same disk. It would protect nothing
the 0600 file does not, so the runner creates none and keeps the file. Even where a keychain exists, its decrypt ACL
trusts only `/usr/bin/security`, so any process already running as the key's owner reads it without a prompt — the
keychain's gain is encryption at rest, not a narrower reader than the 0600 file (threat model C4 row 1). The owner
decided (#585, 2026-11-16, option a) that the `user` backend's `_tcrunner` keeps the 0600 file; a root-written System
keychain item for it is option (b), tracked as #634.

`TC_RUNNER_KEY_STORE` pins the store. `keychain` refuses to enrol or start when there is no usable keychain, and never
writes a file. `file` always uses `keys/runner.key` and never calls `security`. If it is not set, the runner uses the
keychain where one exists and the file otherwise. Any other value is refused. A locked or unreachable keychain
(`security` fails, for example in a session that cannot unlock it) is refused. The runner then says which keychain
failed and does not fall back to a file.

**Moving an existing key file into the keychain.** A runner that finds `keys/runner.key` and a usable keychain moves
the key on its next start (`run`, `run-once` or `update`). It writes the item, reads it back, compares it with the
file and only then deletes the file. If it stops halfway, the next start sees the same key in both places and
deletes the file. A file and an item that hold different keys are refused, and both are kept. Revoke that runner and
enrol again. APFS gives no guarantee that a deleted file's blocks are overwritten. On a disk without FileVault,
treat a key that was ever a file as having been on disk.

**Rotating the key.** There is no in-place rotation. A new key is a new enrolment. Revoke the runner (below), remove
its key from the store it is in, then enrol again with a new code.

**Removing the key** (as the runner's user):

```sh
# keychain item (macOS)
security delete-generic-password -s team-console-runner -a "runner-key:$TC_RUNNER_HOME"
# file
rm "$TC_RUNNER_HOME/keys/runner.key"
```

`security find-generic-password -s team-console-runner -a "runner-key:$TC_RUNNER_HOME"` without `-w` shows whether
the item exists and does not print the key. Use the real path of the home there, as `pwd -P` prints it. A key the first
keychain release saved under the unresolved path of a symlinked home (on macOS `/tmp` is `/private/tmp`) is found
there too: the next start copies it to the real-path account, reads it back and deletes the old item. A home that
does not exist is reported as a missing key, not as a keychain failure. `enrol` refuses a home whose item or file still exists before it sends
the code, so a code is never spent on a home that is already enrolled.

## Credentials: a location or a token, and how to revoke each (RR11, decision 5)

The runner never posts a credential to the console. The console does not know which kind is configured. A Claude
OAuth credential (`setup-token`, `claude-config-dir`) is refused on hosted and Actions dispatch. Any pairing other
than the ones below is refused at `enrol` and again at every launch.

| Kind | Backends | What the job receives | Exposure | Revoke |
| --- | --- | --- | --- | --- |
| `setup-token` (`credentials/claude-setup-token`, 0600) | `user` only | A **token value**. The runner reads the file and gives it to the job user as `CLAUDE_CODE_OAUTH_TOKEN`. `_tcjob` never reads `_tcrunner`'s config directory. | It is valid for about a year. Any job can read it while it runs. | Revoke the token in claude.ai. Run step 2 of "`user` backend" again as `_tcrunner`. Replace the file. Then run `sudo launchctl kickstart -k system/com.team-console.runner`. |
| `claude-config-dir` (`--claude-config-dir <dir>`) | `container` only | A **location**. The runner bind-mounts the directory read-only at `/home/job/.claude` and sets `CLAUDE_CONFIG_DIR`. The runner itself never opens the files. | The job can read the OAuth refresh token in that directory. | Sign out of that device in claude.ai, then sign in again on the host. The old refresh token stops working. |
| `api-key` (`credentials/anthropic.key`, 0600) | every backend | A **key value**. The runner reads the file and puts it in the job's env only, as `ANTHROPIC_API_KEY`. The redactor masks `sk-ant-` in events and logs. | Any job can read it while it runs. | Rotate the key in the Anthropic Console and replace the file. Then restart the service: `launchctl kickstart -k …` or `systemctl --user restart team-console-runner`. |

## Repository config and the git environment (#639, #645, #648)

**Claude CLI launch.** Every job starts the CLI with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` and
`--setting-sources user`. A project `.mcp.json` server therefore never starts (it did in `-p` mode with no approval), and
a branch a job checks out mid-run brings no project `env`, `enabledPlugins` or command setting into the CLI. The cost: a
repository's own `.claude/settings.json` `permissions` do not apply to a job. The launch-time refusal of command-type
project settings stays as the first line.

**Git config refusal (#645).** Besides hooks, `fsmonitor`, `sshCommand`, `include*` and foreign credential helpers, the
runner refuses a mirror or clone whose config sets `core.askPass`, `core.editor`, `core.alternateRefsCommand`,
`remote.*.vcs`, `remote.*.proxy`, `http.proxy` (and `http.<url>.proxy`), `gpg.program` / `gpg.*.program`,
`diff.*.textconv`, `diff.*.command`, `merge.*.driver` or `submodule.*.update`, or that has an
`objects/info/alternates` file. The system scope is not judged. If your upstream needs a proxy, set `HTTPS_PROXY` in
the runner's environment instead.

**Git environment (#648).** The mirror fetch sees only these variables of the runner's process: `HOME`, `PATH`, `USER`,
`LOGNAME`, `TMPDIR`, `SSH_AUTH_SOCK`, `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` (and lower-case forms),
`SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`, and, restored for private upstreams, `XDG_CONFIG_HOME`,
`KRB5CCNAME` and `GNUPGHOME`. A config file under `XDG_CONFIG_HOME` is judged by the same refusal table. Not passed, on
purpose: `SSH_ASKPASS` / `SSH_ASKPASS_REQUIRE` (name a program ssh would run, the same class as `core.askPass`), every
`GIT_*` variable (including `GIT_SSL_*`, `GIT_ASKPASS`, `GIT_SSH_COMMAND`, `GIT_CONFIG_*`), and anything else. For a
private https upstream use the runner's own credential helper; for ssh use an agent (`SSH_AUTH_SOCK`). There is no
operator opt-in to extend the list: a new need is an issue, so each variable gets a review.

## Pause on a usage limit (decision 9, #571)

When the Claude CLI reports a usage or rate limit, the runner finishes that job `failed` with the reason and the reset
time and stops claiming. The pause lasts until the CLI's reset time when the CLI gives one. Otherwise the back-off is
5 → 10 → 20 → 60 minutes, and a successful job resets it. The pause is kept in `TC_RUNNER_HOME/state.json`, so a
restart honours it. It is mirrored to the console. Settings › Runners and the board tile show "paused until …", and the
console's claim skips the runner until that time. The runner posts the pause before it finishes the job, and a limit
failure does not count towards the failure streak only while the console holds that pause (#596): a limit failure
from a runner with no pause on the console counts like any other, and three in a row pause the project. Each left-out
failure is in the audit log as `job.streak-excluded`. A runner older than this change finishes first and pauses
second, so its limit failures count.

The pause lifts by itself. Stage A has no manual resume. Do not delete or edit `state.json`: the runner refuses one
it cannot read, and the console keeps its own copy of the pause until the time it was given. An unknown failure is
never retried. It shows as `failed` with the exit code.

## Update (decision 10, RR13)

`config.json` → `update.policy` decides what the runner does about new releases. The default is `notify`.

| Policy | What happens |
| --- | --- |
| `off` | `update` refuses, and the runner never asks. |
| `notify` | The runner does not ask by itself. Settings › Runners shows the console's release and marks a runner below its minimum. You run `update`. |
| `auto` | The runner asks when it starts and, while idle, at most every 6 hours. It installs a verified release and exits, and its service starts the new version. A refusal is logged and the runner keeps the version it has. Auto stays on the installed channel: a runner on a stable release never moves onto a pre-release (`-rc.1`) by itself. Run `update` by hand for that. A runner on a pre-release moves on to a later pre-release or to the stable release. |

`run-once` with `auto` asks too, before it claims. If it installs a release, it stops with `Runner stopped (updated)`
and claims nothing. Run it again to claim with the new version.

`update` and `auto` run `gh` with only `PATH`, `HOME`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `GH_TOKEN` and
`GITHUB_TOKEN` from the runner's environment. Everything else, `GH_HOST` included, is dropped. A service has no
terminal for `gh auth login`, so log in once as the runner's user (`gh auth login`, stored in that user's
`~/.config/gh`). Or set `GH_TOKEN` in the service's environment to a fine-grained token with no repository access
(public repositories only, read-only). The token reaches `gh` and nothing else: a job is built from an empty
environment and a `*_TOKEN` passthrough is refused (`env-builder.ts`).

`update --check` says whether a release is available. `update` installs it. Both refuse when the policy is `off`. The
console only names a version. `update` decides whether it may install it, against the identity compiled into the
binary (repository `geeera/team-console`, workflow `.github/workflows/release-runner.yml`, ref `refs/tags/v<v>`,
GitHub's OIDC issuer, no self-hosted runner). It delegates the signature and provenance check to `gh attestation
verify`. It refuses when any of these is true, and leaves the install directory untouched:

- `gh` is missing or does not run.
- The console names a lower version than the installed one, or a pre-release of it. A runner is never downgraded.
- The release is below the console's `minimumVersion`.
- The download fails, or `gh attestation verify` fails.
- The tarball holds anything but the release files (an extra file or a symlink), a file does not match the
  `SHA256SUMS` inside the tarball, or the new bundle reports another version.
- The install directory is not owned by, or not writable only by, the user running `update`.

Then it switches the install directory to the new release in one step. Each release gets its own
`releases/<v>/`, and one `current` symlink names the live one. `team-console-runner.mjs`, `SHA256SUMS` and each file in
`bin/` (`job-exec`, `team-console-runner`) are symlinks through `current`, so the service and the launcher keep the
paths they already use; `bin/` itself stays a real directory, so `bin/job-exec` exists at every step. The switch is one
rename of `current`. A crash leaves the old release or the new one, never a mix of both, and the next `update` removes
what the crash left. A crash during the first conversion leaves a prefix that still runs, with some entries linked and
some not: run `update` again, and it finishes the links even when `current` already names the release. If a `bin.flat`
directory is left next to a missing `bin/` (an earlier layout), the next `update` puts it back and links it.
`update auto` never moves a runner that is not on a pre-release (a stable version, or one that is not SemVer) onto a
pre-release; run `update` by hand for that.
The release that was replaced stays in `releases/` until the next update, and older ones are deleted. The first `update`
of a directory you extracted by hand converts it to this layout. Do not extract a tarball into the directory after
that: use `update`. Restart the service so it runs the new version.

**`container` backend** (install directory owned by the runner's user): run `"$R" update`, then
`systemctl --user restart team-console-runner` or `launchctl kickstart -k gui/$(id -u)/com.team-console.runner`. `gh`
must be logged in as that user. The image is separate. Take the new digest from the release notes, verify it (see
"The container image"), set `container.image` in `config.json` to it, run `docker pull <ref>`, and restart.

**`user` backend** (root-owned install directory): `update` refuses there by design, because `_tcrunner` must not be
able to replace what root installed. Update by hand, as an admin:

1. Download and verify the new tarball as in "Get a release and verify it".
2. Run `sudo tar -xzf team-console-runner-<v>-<platform>.tar.gz --no-same-owner -C /usr/local/lib/team-console-runner`.
3. Run `sudo launchctl kickstart -k system/com.team-console.runner`.
4. Run the manual check below again.

## Revoke a runner

1. In the console, open Settings › Runners and use **Revoke** on the runner. From then on the console refuses its
   JWT, so it can claim nothing and post nothing.
2. On the host, stop the service. Use `sudo launchctl bootout system/com.team-console.runner` on `user`, or
   `systemctl --user disable --now team-console-runner` or
   `launchctl bootout gui/$(id -u)/com.team-console.runner` on `container`.
3. Revoke its Claude credential as the table above says. Delete the runner key from its store ("Where the runner
   key is kept" above: the keychain item on a Mac whose runner user has a keychain, otherwise
   `TC_RUNNER_HOME/keys/runner.key`) and `TC_RUNNER_HOME/credentials/`.
4. To enrol the host again, use a new code and an empty `TC_RUNNER_HOME` with no keychain item left for it. The
   runner never overwrites an existing `config.json` or key.

## Manual check on the Mac (L3, plant-then-verify) — `needs:local` (#576)

CI cannot create macOS users, so the owner runs this once after the install and after every runner update. Every
step is expected to pass.

1. `dscl . -read /Users/_tcjob NFSHomeDirectory UserShell` prints `/var/empty` and `/usr/bin/false`.
   `dseditgroup -o checkmember -m _tcjob admin` says *no*.
2. `ls -ld /Users/_tcrunner /Users/_tcrunner/credentials` shows `drwx--x--- _tcrunner _tcjob` and
   `drwx------ _tcrunner`. `sudo -u _tcjob ls /Users/_tcrunner` and `sudo -u _tcjob ls /Users/_tcrunner/credentials`
   are both refused.
   `ls -la /Users/_tcrunner` shows no symlink (#598).
3. `ls -l '/Library/Application Support/ClaudeCode/managed-settings.json'` shows `root wheel` and `-rw-r--r--`.
4. `sudo -l -U _tcrunner` lists exactly one command: `(_tcjob) NOPASSWD: <prefix>/bin/job-exec`.
5. While a job runs, `ls -ld /Users/_tcrunner/jobs/*/sock` shows `drwxr-x--- _tcrunner _tcjob` and the socket is
   `srw-rw----`. A third local user cannot `curl --unix-socket` it.
6. Plant-then-verify: queue the fixture plant job (scenario 3 with the fake CLI as `toolchain.claude`) and then the
   verify job (scenario 4). The second job finishes `clean`. `pgrep -u _tcjob` prints nothing between jobs. A file
   that the first job left in `/tmp`, `/private/var/tmp`, `/Users/Shared` or `_tcjob`'s own `/var/folders/<..>/T`
   and `/C` (`sudo -u _tcjob getconf DARWIN_USER_TEMP_DIR` and `DARWIN_USER_CACHE_DIR`, #600) is gone, and a
   `notice` with `sweep: removed` is on that job's events. A hard link the first job made in its sandbox to a file
   it does not own (`ln /etc/sudoers jobs/<id>/home/x`) does not stop the cleanup or the next preflight (#601).
7. Start a background process as `_tcjob` (`sudo -u _tcjob sleep 999 &`) and wait for the next poll. The runner
   kills it before claiming. If the kill fails, the runner refuses to claim and says why in `logs/runner.log`.
8. `ls -l /usr/local/lib/team-console-runner /usr/local/lib/team-console-runner/bin` shows everything owned by `root`
   and writable by no one else, and `…/bin/team-console-runner version` prints the version you installed.
