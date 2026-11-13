# Runner — install, enrol, credentials, pause, update, revoke and the manual isolation check

The runner runs on the customer's machine and claims jobs from the console. It runs each job as a separate
locked-down user (`user` backend, macOS) or in its own container (`container` backend). `none` is for local
fixtures only. Decisions referenced are those of the architect note on #468 (ADR 0008); threat-model rows are from
`docs/security/`. Commands below use `<v>` for a release version (`0.1.0`) and `<platform>` for one of
`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`.

**Open findings, not yet fixed.** Two SECURITY findings on the installer and the `user` backend are open. Until they
are fixed, follow the precautions given here.

- #598: `install --yes`, run as root, follows a symlink that `_tcrunner` planted under its home when it sets a
  directory's mode. This can deny service but gives no privilege. Before you re-run `sudo … install --backend user
  --yes` on a runner that has already run jobs, check that `ls -la /Users/_tcrunner` shows no symlink for
  `credentials` or `logs`.
- #599: the `_tcrunner` home is `0750 _tcrunner:_tcjob`, so every job can list it and read any file in it that has a
  default mode. Run `claude setup-token` with `umask 077`, as step 2 under "`user` backend" does.

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
- It creates `TC_RUNNER_HOME` as `_tcrunner:_tcjob 0750`, with `credentials/` and `logs/` at 0700 (see #599 above).
- It writes `/Library/Application Support/ClaudeCode/managed-settings.json` as `root:wheel 0644`. All hooks are off,
  and the runner refuses to start a job when this file is not root-owned or has changed.
- It writes `/etc/sudoers.d/team-console-runner` as `0440`, checked with `visudo -c` first. It holds one rule:
  `_tcrunner ALL=(_tcjob) NOPASSWD: <prefix>/bin/job-exec`.
- It writes `/Library/LaunchDaemons/com.team-console.runner.plist`, which runs `run --loop` as `_tcrunner` with
  umask 027.

Then do these steps by hand. The installer never handles a code or a credential.

1. Enrol. Create a one-time code on Settings › Runners, then run:
   `sudo -u _tcrunner env HOME=/Users/_tcrunner TC_RUNNER_HOME=/Users/_tcrunner "$NODE" "$B" enrol --url <console> --code <tce_…> --backend user --credential setup-token`.
   The code is valid for 10 minutes and works once.
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
LaunchAgent (`~/Library/LaunchAgents/com.team-console.runner.plist`). Then enrol with `"$R" enrol --url <console>
--code <tce_…> --backend container --image <same ref> --credential api-key|claude-config-dir [--claude-config-dir
<dir>]`.

Each job runs in its own `--rm` container from that image:

- The root filesystem is read-only, every capability is dropped and `no-new-privileges` is set.
- `HOME`, `TMPDIR` and `/tmp` are on tmpfs.
- The clone is the only writable mount. The socket directory, the plugin, the managed settings and a
  `claude-config-dir` are mounted read-only. `TC_RUNNER_HOME` is never mounted.
- The job's environment reaches it on stdin, never as `-e`.

## Credentials: a location or a token, and how to revoke each (RR11, decision 5)

The runner never posts a credential to the console. The console does not know which kind is configured. A Claude
OAuth credential (`setup-token`, `claude-config-dir`) is refused on hosted and Actions dispatch. Any pairing other
than the ones below is refused at `enrol` and again at every launch.

| Kind | Backends | What the job receives | Exposure | Revoke |
| --- | --- | --- | --- | --- |
| `setup-token` (`credentials/claude-setup-token`, 0600) | `user` only | A **token value**. The runner reads the file and gives it to the job user as `CLAUDE_CODE_OAUTH_TOKEN`. `_tcjob` never reads `_tcrunner`'s config directory. | It is valid for about a year. Any job can read it while it runs. | Revoke the token in claude.ai. Run step 2 of "`user` backend" again as `_tcrunner`. Replace the file. Then run `sudo launchctl kickstart -k system/com.team-console.runner`. |
| `claude-config-dir` (`--claude-config-dir <dir>`) | `container` only | A **location**. The runner bind-mounts the directory read-only at `/home/job/.claude` and sets `CLAUDE_CONFIG_DIR`. The runner itself never opens the files. | The job can read the OAuth refresh token in that directory. | Sign out of that device in claude.ai, then sign in again on the host. The old refresh token stops working. |
| `api-key` (`credentials/anthropic.key`, 0600) | every backend | A **key value**. The runner reads the file and puts it in the job's env only, as `ANTHROPIC_API_KEY`. The redactor masks `sk-ant-` in events and logs. | Any job can read it while it runs. | Rotate the key in the Anthropic Console and replace the file. Then restart the service: `launchctl kickstart -k …` or `systemctl --user restart team-console-runner`. |

## Pause on a usage limit (decision 9, #571)

When the Claude CLI reports a usage or rate limit, the runner finishes that job `failed` with the reason and the reset
time and stops claiming. The pause lasts until the CLI's reset time when the CLI gives one. Otherwise the back-off is
5 → 10 → 20 → 60 minutes, and a successful job resets it. The pause is kept in `TC_RUNNER_HOME/state.json`, so a
restart honours it. It is mirrored to the console. Settings › Runners and the board tile show "paused until …", and the
console's claim skips the runner until that time. A limit failure does not count towards the failure streak.

The pause lifts by itself. Stage A has no manual resume. Do not delete or edit `state.json`: the runner refuses one
it cannot read, and the console keeps its own copy of the pause until the time it was given. An unknown failure is
never retried. It shows as `failed` with the exit code.

## Update (decision 10, RR13)

`config.json` → `update.policy` decides what the runner does about new releases. The default is `notify`.

| Policy | What happens |
| --- | --- |
| `off` | `update` refuses, and the runner never asks. |
| `notify` | The runner does not ask by itself. Settings › Runners shows the console's release and marks a runner below its minimum. You run `update`. |
| `auto` | The runner asks when it starts and, while idle, at most every 6 hours. It installs a verified release and exits, and its service starts the new version. A refusal is logged and the runner keeps the version it has. |

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

Then it swaps the files in, with the bundle last. Restart the service so it runs the new version.

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
3. Revoke its Claude credential as the table above says. Delete `TC_RUNNER_HOME/keys/runner.key` and
   `TC_RUNNER_HOME/credentials/`.
4. To enrol the host again, use a new code and an empty `TC_RUNNER_HOME`. The runner never overwrites an existing
   `config.json` or key.

## Manual check on the Mac (L3, plant-then-verify) — `needs:local` (#576)

CI cannot create macOS users, so the owner runs this once after the install and after every runner update. Every
step is expected to pass.

1. `dscl . -read /Users/_tcjob NFSHomeDirectory UserShell` prints `/var/empty` and `/usr/bin/false`.
   `dseditgroup -o checkmember -m _tcjob admin` says *no*.
2. `ls -ld /Users/_tcrunner /Users/_tcrunner/credentials` shows `drwxr-x--- _tcrunner _tcjob` and
   `drwx------ _tcrunner`. `sudo -u _tcjob ls /Users/_tcrunner/credentials` is refused.
   `ls -la /Users/_tcrunner` shows no symlink (#598).
3. `ls -l '/Library/Application Support/ClaudeCode/managed-settings.json'` shows `root wheel` and `-rw-r--r--`.
4. `sudo -l -U _tcrunner` lists exactly one command: `(_tcjob) NOPASSWD: <prefix>/bin/job-exec`.
5. While a job runs, `ls -ld /Users/_tcrunner/jobs/*/sock` shows `drwxr-x--- _tcrunner _tcjob` and the socket is
   `srw-rw----`. A third local user cannot `curl --unix-socket` it.
6. Plant-then-verify: queue the fixture plant job (scenario 3 with the fake CLI as `toolchain.claude`) and then the
   verify job (scenario 4). The second job finishes `clean`. `pgrep -u _tcjob` prints nothing between jobs. A file
   that the first job left in `/tmp`, `/private/var/tmp` or `/Users/Shared` is gone, and a `notice` with
   `sweep: removed` is on that job's events.
7. Start a background process as `_tcjob` (`sudo -u _tcjob sleep 999 &`) and wait for the next poll. The runner
   kills it before claiming. If the kill fails, the runner refuses to claim and says why in `logs/runner.log`.
8. `ls -l /usr/local/lib/team-console-runner /usr/local/lib/team-console-runner/bin` shows everything owned by `root`
   and writable by no one else, and `…/bin/team-console-runner version` prints the version you installed.
