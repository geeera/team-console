#!/usr/bin/env node
// Not a Vitest spec: this tool lives outside the Nx graph (CI must be able to run it before `npm ci`/a full
// build) and only needs Node's builtin `assert`, run directly by security.yml's `workflow-lint` job, next to
// the other tools/*.test.* files (see tools/deploy-guard/check-d1-placeholder.test.js for the same pattern).
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  evaluateAuditReport,
  parseAuditReport,
  loadAllowlist,
  assertReportIntegrity,
  collectAdvisories,
} from './audit-gate.mjs';

const NOW = new Date('2026-10-04T00:00:00Z');

const ALLOWLIST = [
  {
    ghsaId: 'GHSA-vfj7-8cjw-p6xm',
    package: 'braces',
    reason: 'no patched version exists; build-tooling only (#177)',
    issue: 177,
    expires: '2026-11-03',
  },
];

function reportWith(advisory) {
  return {
    vulnerabilities: {
      [advisory.package]: {
        name: advisory.package,
        severity: advisory.severity,
        via: [
          {
            source: 1,
            name: advisory.package,
            title: 'some advisory',
            url: `https://github.com/advisories/${advisory.ghsaId}`,
            severity: advisory.severity,
            range: '*',
          },
        ],
      },
    },
  };
}

// --- a clean report passes ---
{
  const { failures, ignored } = evaluateAuditReport({ vulnerabilities: {} }, ALLOWLIST, NOW);
  assert.deepStrictEqual(failures, [], 'a clean report must have no failures');
  assert.deepStrictEqual(ignored, [], 'a clean report must have nothing to ignore');
}

// --- a non-allowlisted high fails ---
{
  const report = reportWith({ package: 'lodash', severity: 'high', ghsaId: 'GHSA-aaaa-bbbb-cccc' });
  const { failures, ignored } = evaluateAuditReport(report, ALLOWLIST, NOW);
  assert.strictEqual(failures.length, 1, 'a non-allowlisted high advisory must fail');
  assert.strictEqual(failures[0].package, 'lodash');
  assert.deepStrictEqual(ignored, []);
}

// --- an allowlisted high before expiry passes ---
{
  const report = reportWith({ package: 'braces', severity: 'high', ghsaId: 'GHSA-vfj7-8cjw-p6xm' });
  const { failures, ignored } = evaluateAuditReport(report, ALLOWLIST, NOW);
  assert.deepStrictEqual(failures, [], 'an allowlisted, unexpired advisory must not fail');
  assert.strictEqual(ignored.length, 1);
  assert.strictEqual(ignored[0].issue, 177);
}

// --- after expiry it fails again ---
{
  const report = reportWith({ package: 'braces', severity: 'high', ghsaId: 'GHSA-vfj7-8cjw-p6xm' });
  const afterExpiry = new Date('2026-11-03T00:00:00Z'); // expiry date itself counts as expired
  const { failures, ignored } = evaluateAuditReport(report, ALLOWLIST, afterExpiry);
  assert.strictEqual(failures.length, 1, 'an expired allowlist entry must fail again');
  assert.strictEqual(failures[0].expiredMatch, true);
  assert.deepStrictEqual(ignored, []);

  const theDayBefore = new Date('2026-11-02T23:59:59Z');
  const stillOk = evaluateAuditReport(report, ALLOWLIST, theDayBefore);
  assert.deepStrictEqual(stillOk.failures, [], 'one second before expiry must still pass');
}

// --- critical fails unless allowlisted ---
{
  const report = reportWith({ package: 'left-pad', severity: 'critical', ghsaId: 'GHSA-dddd-eeee-ffff' });
  const { failures } = evaluateAuditReport(report, ALLOWLIST, NOW);
  assert.strictEqual(failures.length, 1, 'a critical advisory must fail unless allowlisted');
}
{
  // A critical advisory can also be allowlisted — the gate does not special-case severity, only identity.
  const criticalAllowlist = [{ ...ALLOWLIST[0], ghsaId: 'GHSA-dddd-eeee-ffff', package: 'left-pad' }];
  const report = reportWith({ package: 'left-pad', severity: 'critical', ghsaId: 'GHSA-dddd-eeee-ffff' });
  const { failures, ignored } = evaluateAuditReport(report, criticalAllowlist, NOW);
  assert.deepStrictEqual(failures, []);
  assert.strictEqual(ignored.length, 1);
}

// --- moderate/low advisories never count, allowlisted or not ---
{
  const report = reportWith({ package: 'some-pkg', severity: 'moderate', ghsaId: 'GHSA-gggg-hhhh-iiii' });
  const { failures, ignored } = evaluateAuditReport(report, ALLOWLIST, NOW);
  assert.deepStrictEqual(failures, []);
  assert.deepStrictEqual(ignored, []);
}

// --- an allowlist entry for one advisory must not mask another advisory on the same package ---
{
  const report = {
    vulnerabilities: {
      braces: {
        name: 'braces',
        severity: 'high',
        via: [
          {
            source: 1,
            name: 'braces',
            title: 'the allowlisted advisory',
            url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
            severity: 'high',
          },
          {
            source: 2,
            name: 'braces',
            title: 'a different, unrelated advisory on the same package',
            url: 'https://github.com/advisories/GHSA-zzzz-yyyy-xxxx',
            severity: 'high',
          },
        ],
      },
    },
  };
  const { failures, ignored } = evaluateAuditReport(report, ALLOWLIST, NOW);
  assert.strictEqual(ignored.length, 1, 'only the allowlisted GHSA id is ignored');
  assert.strictEqual(failures.length, 1, 'the other advisory on the same package must still fail');
  assert.strictEqual(failures[0].ghsaId, 'GHSA-zzzz-yyyy-xxxx');
}

// --- an allowlist entry must only match its own package, not a same-named advisory on another package ---
{
  const report = reportWith({ package: 'some-other-package', severity: 'high', ghsaId: 'GHSA-vfj7-8cjw-p6xm' });
  const { failures, ignored } = evaluateAuditReport(report, ALLOWLIST, NOW);
  assert.strictEqual(failures.length, 1, 'the same GHSA id on a different package must not be masked');
  assert.deepStrictEqual(ignored, []);
}

// --- an advisory entry with no extractable GHSA id fails closed, it is never silently skipped ---
{
  const report = {
    vulnerabilities: {
      mystery: {
        name: 'mystery',
        severity: 'high',
        via: [{ source: 1, name: 'mystery', title: 'no url field', severity: 'high' }],
      },
    },
  };
  const { failures } = evaluateAuditReport(report, ALLOWLIST, NOW);
  assert.strictEqual(failures.length, 1, 'an advisory with no identifiable GHSA id must fail closed');
  assert.strictEqual(failures[0].ghsaId, null);
}

// --- malformed/unexpected report shapes fail closed ---
{
  assert.throws(
    () => evaluateAuditReport({}, ALLOWLIST, NOW),
    /no "vulnerabilities" object/,
    'a report with no vulnerabilities object must throw, not pass silently',
  );
  assert.throws(() => evaluateAuditReport(null, ALLOWLIST, NOW), /no "vulnerabilities" object/);
  assert.throws(() => evaluateAuditReport({ vulnerabilities: 'nope' }, ALLOWLIST, NOW), /no "vulnerabilities" object/);
}

// --- malformed JSON from `npm audit --json` fails, it is never treated as "no vulnerabilities" ---
{
  assert.throws(
    () => parseAuditReport('{ not valid json'),
    /not valid JSON/,
    'malformed npm audit output must throw, not parse into an empty report',
  );
  assert.throws(() => parseAuditReport(''), /not valid JSON/, 'empty npm audit output must also fail');
}

// --- an advisory missing a name, missing a severity, or with an unknown severity fails closed (#180 review) ---
{
  const missingName = {
    vulnerabilities: { mystery: { severity: 'high', via: [{ source: 1, severity: 'high', url: 'x' }] } },
  };
  assert.throws(() => collectAdvisories(missingName), /missing a package name/);

  const missingSeverity = {
    vulnerabilities: { braces: { name: 'braces', via: [{ source: 1, name: 'braces', url: 'x' }] } },
  };
  assert.throws(() => collectAdvisories(missingSeverity), /missing a severity/);

  const unknownSeverity = {
    vulnerabilities: {
      braces: { name: 'braces', severity: 'apocalyptic', via: [{ source: 1, name: 'braces', severity: 'apocalyptic', url: 'x' }] },
    },
  };
  assert.throws(() => collectAdvisories(unknownSeverity), /unknown severity/);
}

// --- report integrity: a non-zero npm audit exit that yields zero parsed advisories must fail, not pass ---
{
  assert.throws(
    () => assertReportIntegrity({ vulnerabilities: {} }, 1, []),
    /no advisories could be parsed/,
    'a failed npm audit run with nothing collected must not be treated as clean',
  );
  // exit 0 with nothing collected is a genuinely clean audit — must not throw.
  assertReportIntegrity({ vulnerabilities: {} }, 0, []);
}

// --- report integrity: metadata counting high/critical packages while nothing was collected must fail ---
{
  const report = { metadata: { vulnerabilities: { high: 3, critical: 0 } } };
  // status 0 here isolates this check from the "non-zero exit with nothing collected" one above.
  assert.throws(
    () => assertReportIntegrity(report, 0, []),
    /metadata reports 3 high\/critical/,
    'metadata reporting vulnerable packages with zero collected advisories must fail, not pass silently',
  );
  // the real shape (metadata counts packages, collectAdvisories counts distinct advisories) is expected to
  // differ in absolute numbers — only "metadata says some, we found none" is the failure case.
  assertReportIntegrity(report, 0, [{ severity: 'high', ghsaId: 'GHSA-aaaa-bbbb-cccc', package: 'braces' }]);
}

// --- loadAllowlist ---
function withTempFile(contents, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-gate-allowlist-'));
  const file = path.join(dir, '.audit-allowlist.json');
  if (contents !== null) writeFileSync(file, contents, 'utf8');
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const validEntryJson = JSON.stringify({
  entries: [{ ghsaId: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', reason: 'no fix yet', issue: 177, expires: '2026-11-03' }],
});

withTempFile(null, (file) => {
  assert.deepStrictEqual(loadAllowlist(file, NOW), [], 'a missing allowlist file is an empty allowlist');
});

withTempFile('{ not valid json', (file) => {
  assert.throws(() => loadAllowlist(file, NOW), /not valid JSON/, 'malformed allowlist JSON must fail');
});

withTempFile('[]', (file) => {
  assert.throws(() => loadAllowlist(file, NOW), /must have an "entries" array/, 'a non-object root must fail');
});

withTempFile(JSON.stringify({ entries: [{ package: 'braces', reason: 'x', issue: 177, expires: '2026-11-03' }] }), (file) => {
  assert.throws(() => loadAllowlist(file, NOW), /missing required field "ghsaId"/, 'a missing required field must fail');
});

withTempFile(
  JSON.stringify({ entries: [{ ghsaId: 'not-a-ghsa-id', package: 'braces', reason: 'x', issue: 177, expires: '2026-11-03' }] }),
  (file) => {
    assert.throws(() => loadAllowlist(file, NOW), /is not a GHSA id/, 'a non-GHSA ghsaId must fail');
  },
);

withTempFile(
  JSON.stringify({
    entries: [{ ghsaId: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', reason: 'x', issue: 177, expires: '2026/11/03' }],
  }),
  (file) => {
    assert.throws(() => loadAllowlist(file, NOW), /strict YYYY-MM-DD/, 'a non-strict date format must fail');
  },
);

withTempFile(
  JSON.stringify({
    entries: [{ ghsaId: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', reason: 'x', issue: 177, expires: '2026-02-30' }],
  }),
  (file) => {
    assert.throws(
      () => loadAllowlist(file, NOW),
      /strict YYYY-MM-DD/,
      'an impossible calendar date (Feb 30) must fail, not silently roll over to March',
    );
  },
);

withTempFile(
  JSON.stringify({
    // NOW is 2026-10-04; 2027-06-01 is well past the 90-day horizon.
    entries: [{ ghsaId: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', reason: 'x', issue: 177, expires: '2027-06-01' }],
  }),
  (file) => {
    assert.throws(
      () => loadAllowlist(file, NOW),
      /more than 90 days/,
      'an expiry more than 90 days out must fail — exceptions must stay narrow and time-boxed',
    );
  },
);

withTempFile(
  JSON.stringify({
    // exactly 90 days from NOW (2026-10-04 + 90 days) must still be accepted.
    entries: [{ ghsaId: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', reason: 'x', issue: 177, expires: '2027-01-02' }],
  }),
  (file) => {
    const loaded = loadAllowlist(file, NOW);
    assert.strictEqual(loaded.length, 1, 'an expiry exactly at the 90-day horizon must be accepted');
  },
);

withTempFile(validEntryJson, (file) => {
  const loaded = loadAllowlist(file, NOW);
  assert.strictEqual(loaded.length, 1);
  assert.strictEqual(loaded[0].package, 'braces');
});

process.stdout.write('ok: audit-gate ignores only matching, unexpired allowlist entries and fails closed otherwise\n');
