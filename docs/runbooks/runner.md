# Runner — install, credentials and the manual isolation check (draft)

Draft from 2-B-3 (#570). 2-B-5 completes it with the release download, `gh attestation verify`, `update`, the
usage-limit pause and the revoke flow. Decisions referenced are those of the architect note on #468 (ADR 0008).

The runner runs on the customer's machine and claims jobs from the console. It runs each job as a separate
locked-down user (`user` backend, macOS) or in its own container (`container` backend). `none` is for local
fixtures only.

## Install the release (both backends)

1. Extract the release into a root-owned directory. The default is `/usr/local/lib/team-console-runner`, and it must
   hold `team-console-runner.mjs` and `bin/job-exec`. Use `sudo tar -xf … -C /usr/local/lib/team-console-runner`.
   `install --backend user` refuses a directory, bundle or `job-exec` that is not root-owned or that anyone else can
   write: the sudoers rule names that file.
2. Run `install --dry-run` first. It lists every step and changes nothing. Then run the same command with `--yes`.

## `user` backend (macOS)

```sh
sudo node /usr/local/lib/team-console-runner/team-console-runner.mjs install --backend user --dry-run
sudo node /usr/local/lib/team-console-runner/team-console-runner.mjs install --backend user --yes
```

What `--yes` does. It writes only these paths (decision 11, threat model C11):

- It creates the group `_tcjob`. It creates the users `_tcjob` (home `/var/empty`, which is root-owned) and
  `_tcrunner` (home = `TC_RUNNER_HOME`, default `/Users/_tcrunner`, primary group `_tcjob`). Both are hidden, have
  shell `/usr/bin/false` and no password. An existing user is kept, but the installer refuses one that is in `admin`.
- It creates `TC_RUNNER_HOME` as `_tcrunner:_tcjob 0750`, with `credentials/` and `logs/` at 0700.
- It writes `/Library/Application Support/ClaudeCode/managed-settings.json` as `root:wheel 0644`. All hooks are off,
  and the runner refuses to start a job when this file is not root-owned or has changed.
- It writes `/etc/sudoers.d/team-console-runner` as `0440`, checked with `visudo -c` first. It holds one rule:
  `_tcrunner ALL=(_tcjob) NOPASSWD: <prefix>/bin/job-exec`.
- It writes `/Library/LaunchDaemons/com.team-console.runner.plist`, which runs `run --loop` as `_tcrunner` with
  umask 027.

Then do these steps by hand (the installer never handles a code or a credential):

1. Enrol: `sudo -u _tcrunner env HOME=/Users/_tcrunner TC_RUNNER_HOME=/Users/_tcrunner node <prefix>/team-console-runner.mjs enrol --url <console> --code <tce_…> --backend user --credential setup-token`.
2. Credential: run `sudo -u _tcrunner env HOME=/Users/_tcrunner claude setup-token`. Then store the token it prints
   with `sudo -u _tcrunner sh -c 'umask 077; cat > /Users/_tcrunner/credentials/claude-setup-token'` (paste the
   token, then Ctrl-D).
3. Start: `sudo launchctl bootstrap system /Library/LaunchDaemons/com.team-console.runner.plist`.

The toolchain the jobs use (`config.toolchain.path`, Homebrew's `node`, `git`, `claude`) must be readable and
executable by `_tcjob`.

**Credential exposure (RR11).** On `user` the only Claude credential is a `claude setup-token` token (decision 5).
It is valid for about a year, it is injected per job as `CLAUDE_CODE_OAUTH_TOKEN`, and an injected job can read it.
To revoke it: revoke the token in claude.ai, run `claude setup-token` again as `_tcrunner`, replace the file, then
run `sudo launchctl kickstart -k system/com.team-console.runner`. The other choice is an Anthropic API key
(`--credential api-key`, `credentials/anthropic.key` 0600). The runner refuses `claude-config-dir` on `user`.

## `container` backend (Linux, or Docker/OrbStack on a Mac)

```sh
node <prefix>/team-console-runner.mjs install --backend container --image ghcr.io/geeera/team-console-runner:<v>@sha256:<digest> --dry-run
node <prefix>/team-console-runner.mjs install --backend container --image … --yes
```

Run these as the user the runner runs as, **not** with sudo. The installer pulls the image by digest. It creates
`TC_RUNNER_HOME` at 0700. It writes a systemd user unit (`~/.config/systemd/user/team-console-runner.service`) or a
LaunchAgent (`~/Library/LaunchAgents/com.team-console.runner.plist`). Then enrol with `--backend container --image
<same ref> --credential api-key|claude-config-dir`.

Each job runs in its own `--rm` container from that image:

- The root filesystem is read-only, every capability is dropped and `no-new-privileges` is set.
- `HOME`, `TMPDIR` and `/tmp` are on tmpfs.
- The clone is the only writable mount. The socket directory, the plugin, the managed settings and a
  `claude-config-dir` are mounted read-only. `TC_RUNNER_HOME` is never mounted.
- The job's environment reaches it on stdin, never as `-e`.

**Credential exposure (RR11).** `claude-config-dir` mounts your Claude config read-only at `/home/job/.claude`. A job
can read the OAuth refresh token in it. To revoke: sign out of that device in claude.ai, then sign in again. For an
API key, rotate it in the Anthropic Console, replace the file, and restart the unit.

## Manual check on the Mac (L3, plant-then-verify) — `needs:local` (#576)

CI cannot create macOS users, so the owner runs this once after the install and after every runner update. Every
step is expected to pass.

1. `dscl . -read /Users/_tcjob NFSHomeDirectory UserShell` prints `/var/empty` and `/usr/bin/false`.
   `dseditgroup -o checkmember -m _tcjob admin` says *no*.
2. `ls -ld /Users/_tcrunner /Users/_tcrunner/credentials` shows `drwxr-x--- _tcrunner _tcjob` and
   `drwx------ _tcrunner`. `sudo -u _tcjob ls /Users/_tcrunner/credentials` is refused.
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
