#!/usr/bin/env node
// End-to-end regression for #180: `audit-gate.mjs` must actually run `main()` when Node is asked to run it as
// a script, even from a path that doesn't round-trip through a plain string compare of `import.meta.url` and
// `process.argv[1]` (a space in the path is the simplest such case; a symlink or non-ASCII character triggers
// the same gap). Spawns the real script as a child process from inside a directory whose name contains a
// space, with a fake `npm` placed first on PATH so no real npm registry call happens and the report is fully
// controlled by this test.
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_SOURCE = fileURLToPath(new URL('./audit-gate.mjs', import.meta.url));

const REAL_ALLOWLIST = {
  entries: [
    {
      ghsaId: 'GHSA-vfj7-8cjw-p6xm',
      package: 'braces',
      reason: 'no patched version exists; build-tooling only (#177)',
      issue: 177,
      expires: '2026-11-03',
    },
  ],
};

const EXPIRED_ALLOWLIST = {
  entries: [{ ...REAL_ALLOWLIST.entries[0], expires: '2020-01-01' }],
};

const BRACES_REPORT = {
  vulnerabilities: {
    braces: {
      name: 'braces',
      severity: 'high',
      via: [
        {
          source: 1240992,
          name: 'braces',
          title: 'uncontrolled recursion',
          url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
          severity: 'high',
        },
      ],
    },
  },
  metadata: { vulnerabilities: { high: 1, critical: 0 } },
};

const LODASH_CRITICAL_REPORT = {
  vulnerabilities: {
    lodash: {
      name: 'lodash',
      severity: 'critical',
      via: [
        {
          source: 9999,
          name: 'lodash',
          title: 'prototype pollution',
          url: 'https://github.com/advisories/GHSA-1111-2222-3333',
          severity: 'critical',
        },
      ],
    },
  },
  metadata: { vulnerabilities: { high: 0, critical: 1 } },
};

/** Builds `<dir>/fakebin/npm`: a fake `npm` that ignores its arguments and prints `report`, exiting `exitCode`. */
function writeFakeNpm(dir, report, exitCode) {
  const fakeBinDir = path.join(dir, 'fakebin');
  mkdirSync(fakeBinDir, { recursive: true });
  const npmPath = path.join(fakeBinDir, 'npm');
  const source =
    '#!/usr/bin/env node\n' +
    `process.stdout.write(${JSON.stringify(JSON.stringify(report))});\n` +
    `process.exitCode = ${exitCode};\n`;
  writeFileSync(npmPath, source, 'utf8');
  chmodSync(npmPath, 0o755);
  return fakeBinDir;
}

/** Copies the real script + `allowlist` into a fresh "<root with a space>/tools/ci/audit-gate.mjs" layout. */
function setupWorkspace(allowlist) {
  const root = mkdtempSync(path.join(tmpdir(), 'audit gate e2e '));
  const scriptDir = path.join(root, 'tools', 'ci');
  mkdirSync(scriptDir, { recursive: true });
  cpSync(SCRIPT_SOURCE, path.join(scriptDir, 'audit-gate.mjs'));
  writeFileSync(path.join(root, '.audit-allowlist.json'), JSON.stringify(allowlist), 'utf8');
  return { root, scriptPath: path.join(scriptDir, 'audit-gate.mjs') };
}

function runAuditGate({ allowlist, report, npmExitCode }) {
  const { root, scriptPath } = setupWorkspace(allowlist);
  assert.ok(root.includes(' '), 'the workspace root must contain a space to reproduce #180');
  try {
    const fakeBinDir = writeFakeNpm(root, report, npmExitCode);
    return spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}` },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- the valid, unexpired braces entry: exit 0 ---
{
  const result = runAuditGate({ allowlist: REAL_ALLOWLIST, report: BRACES_REPORT, npmExitCode: 1 });
  assert.strictEqual(
    result.status,
    0,
    `an allowlisted, unexpired advisory must exit 0 from a path with a space in it ` +
      `(stdout: ${result.stdout}, stderr: ${result.stderr})`,
  );
  assert.match(result.stdout, /ignoring high braces GHSA-vfj7-8cjw-p6xm/);
}

// --- an expired allowlist entry: non-zero exit ---
{
  const result = runAuditGate({ allowlist: EXPIRED_ALLOWLIST, report: BRACES_REPORT, npmExitCode: 1 });
  assert.notStrictEqual(
    result.status,
    0,
    `an expired allowlist entry must fail again, not pass silently (stdout: ${result.stdout}, stderr: ${result.stderr})`,
  );
  assert.match(result.stderr, /allowlist entry expired/);
}

// --- a critical, non-allowlisted advisory: non-zero exit ---
{
  const result = runAuditGate({ allowlist: REAL_ALLOWLIST, report: LODASH_CRITICAL_REPORT, npmExitCode: 1 });
  assert.notStrictEqual(
    result.status,
    0,
    `a critical advisory with no allowlist entry must fail (stdout: ${result.stdout}, stderr: ${result.stderr})`,
  );
  assert.match(result.stderr, /critical lodash/);
}

// --- regression guard for #180 itself: the old string-compare guard would have exited 0 here with no output ---
{
  const result = runAuditGate({ allowlist: REAL_ALLOWLIST, report: LODASH_CRITICAL_REPORT, npmExitCode: 1 });
  assert.notStrictEqual(result.stdout + result.stderr, '', 'main() must actually run and produce output');
}

process.stdout.write('ok: audit-gate.mjs runs main() and reports correctly when spawned from a path with a space\n');
