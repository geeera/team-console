#!/usr/bin/env node
// security.yml's `dependency-audit` job. Replaces a bare `npm audit --audit-level=high` (#177): that command has
// no way to except one advisory, so the day an advisory with no patched version lands (GHSA-vfj7-8cjw-p6xm,
// braces — devDependency-only build tooling, not shipped in any deployed bundle) it blocks every PR until
// upstream ships a fix, with no narrow way to accept the risk in the meantime.
//
// Runs `npm audit --json`, walks every advisory `npm audit` found, and fails on any "high"/"critical" one
// *unless* it has a matching, unexpired entry in `.audit-allowlist.json`. A match requires both the GHSA id
// and the affected package name: an allowlist entry for one advisory must never mask a different advisory,
// even one on the same package. No new npm dependency — this only needs Node's `node:child_process`/`node:fs`.

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const GHSA_RE = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i;
const KNOWN_SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);
const SEVERITIES_THAT_FAIL = new Set(['high', 'critical']);
const EXPIRES_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ALLOWLIST_ENTRY_DAYS = 90;

function extractGhsaId(url) {
  if (typeof url !== 'string') return null;
  const match = GHSA_RE.exec(url);
  return match ? match[0] : null;
}

/**
 * Walks `npm audit --json`'s `vulnerabilities` map and returns one entry per distinct (GHSA id, package, url)
 * tuple found in a `via` array. `via` mixes two shapes: an advisory object (direct finding, has `url`/
 * `severity`/`name`) and a plain package-name string (this package is vulnerable only because it depends on
 * that other package, whose own entry in the map carries the real advisory) — only the object shape is a
 * reportable advisory; the string shape is skipped here and picked up from that other package's own entry
 * instead.
 *
 * Fails closed rather than silently dropping a finding: an advisory object missing both its own `name` and a
 * usable package-level fallback, missing a `severity`, or carrying a `severity` outside npm's known set all
 * throw instead of being `continue`d past — a parsing gap must surface as a failed gate, not a clean one. An
 * advisory missing a `url` (so no GHSA id can be extracted) still appears in the result with `ghsaId: null`;
 * the gate never matches a `null` id against the allowlist, so it fails closed there too.
 */
export function collectAdvisories(report) {
  const vulnerabilities = report?.vulnerabilities;
  if (typeof vulnerabilities !== 'object' || vulnerabilities === null) {
    throw new Error('npm audit report has no "vulnerabilities" object');
  }

  const advisories = new Map();
  for (const pkgReport of Object.values(vulnerabilities)) {
    const via = Array.isArray(pkgReport?.via) ? pkgReport.via : [];
    for (const entry of via) {
      if (typeof entry !== 'object' || entry === null) continue; // a package-name string, not an advisory

      const pkg = typeof entry.name === 'string' ? entry.name : pkgReport?.name;
      if (typeof pkg !== 'string') {
        throw new Error('an advisory is missing a package name, and its package-level report has none either');
      }

      const severity = typeof entry.severity === 'string' ? entry.severity : pkgReport?.severity;
      if (typeof severity !== 'string') {
        throw new Error(`advisory on package "${pkg}" is missing a severity`);
      }
      if (!KNOWN_SEVERITIES.has(severity)) {
        throw new Error(`advisory on package "${pkg}" has an unknown severity "${severity}"`);
      }

      const ghsaId = extractGhsaId(entry.url);
      const key = `${ghsaId ?? '(unidentified)'}|${pkg}|${entry.url ?? ''}`;
      if (!advisories.has(key)) {
        advisories.set(key, { ghsaId, package: pkg, severity, url: entry.url ?? null, title: entry.title ?? null });
      }
    }
  }
  return [...advisories.values()];
}

/**
 * `npm audit` exits non-zero whenever it reports anything, and this gate's job is to decide *which* of those
 * reports still fail after the allowlist — so an npm audit failure that yields zero parsed advisories (a
 * broken/truncated report, an unexpected top-level shape) must itself be a failure, not a pass. Cross-checks
 * `metadata.vulnerabilities`' high/critical package counts against what `collectAdvisories` actually found:
 * metadata counts packages, `collectAdvisories` counts distinct advisories, so they are never expected to be
 * equal — but metadata reporting vulnerable packages while zero advisories were collected means parsing lost
 * findings, which must fail rather than silently pass as "0 high/critical advisories".
 */
export function assertReportIntegrity(report, npmAuditExitStatus, advisories) {
  if (npmAuditExitStatus !== 0 && advisories.length === 0) {
    throw new Error(
      `npm audit exited ${npmAuditExitStatus} but no advisories could be parsed from its report — refusing to ` +
        'treat a failed audit run as clean',
    );
  }

  const metaVulnerabilities = report?.metadata?.vulnerabilities;
  const metaHigh = typeof metaVulnerabilities?.high === 'number' ? metaVulnerabilities.high : 0;
  const metaCritical = typeof metaVulnerabilities?.critical === 'number' ? metaVulnerabilities.critical : 0;
  const collectedHighCritical = advisories.filter((advisory) => SEVERITIES_THAT_FAIL.has(advisory.severity)).length;

  if (metaHigh + metaCritical > 0 && collectedHighCritical === 0) {
    throw new Error(
      `npm audit's metadata reports ${metaHigh + metaCritical} high/critical vulnerable package(s) but no ` +
        'matching advisory could be collected from "vulnerabilities" — refusing to pass silently',
    );
  }
}

/** True only for a real calendar date in strict `YYYY-MM-DD` form (rejects e.g. "2026-02-30"). */
function parseStrictCalendarDate(dateString) {
  if (typeof dateString !== 'string' || !EXPIRES_RE.test(dateString)) return null;
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Loads and validates `.audit-allowlist.json`. A missing file is an empty allowlist (nothing is ignored, so
 * this never widens what the gate accepts); any other read failure, malformed JSON, a missing required field,
 * an `expires` that is not a strict, real `YYYY-MM-DD` calendar date, or an `expires` more than
 * `MAX_ALLOWLIST_ENTRY_DAYS` days from `now` all throw — an allowlist the gate cannot fully validate must never
 * be partially honoured.
 */
export function loadAllowlist(filePath, now = new Date()) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }

  const entries = parsed?.entries;
  if (!Array.isArray(entries)) {
    throw new Error(`${filePath} must have an "entries" array`);
  }

  const today = utcMidnight(now);
  const maxExpiry = new Date(today.getTime() + MAX_ALLOWLIST_ENTRY_DAYS * 24 * 60 * 60 * 1000);

  return entries.map((entry, index) => {
    for (const field of ['ghsaId', 'package', 'reason', 'issue', 'expires']) {
      if (!(field in entry)) {
        throw new Error(`${filePath} entries[${index}] is missing required field "${field}"`);
      }
    }
    if (typeof entry.ghsaId !== 'string' || !GHSA_RE.test(entry.ghsaId)) {
      throw new Error(`${filePath} entries[${index}].ghsaId ("${entry.ghsaId}") is not a GHSA id`);
    }
    if (typeof entry.package !== 'string' || entry.package.length === 0) {
      throw new Error(`${filePath} entries[${index}].package must be a non-empty string`);
    }

    const expiresDate = parseStrictCalendarDate(entry.expires);
    if (!expiresDate) {
      throw new Error(
        `${filePath} entries[${index}].expires ("${entry.expires}") must be a real calendar date in strict YYYY-MM-DD form`,
      );
    }
    if (expiresDate.getTime() > maxExpiry.getTime()) {
      throw new Error(
        `${filePath} entries[${index}].expires ("${entry.expires}") is more than ${MAX_ALLOWLIST_ENTRY_DAYS} days ` +
          'from now — an exception must stay narrow and time-boxed',
      );
    }
    return entry;
  });
}

function isExpired(allowlistEntry, now) {
  const expires = new Date(`${allowlistEntry.expires}T00:00:00Z`);
  return now.getTime() >= expires.getTime();
}

/**
 * Returns `{ failures, ignored }` for every high/critical advisory `npm audit` found. An advisory is `ignored`
 * only when the allowlist has an entry whose `ghsaId` *and* `package` both match it, and that entry has not
 * expired; everything else — no match, a package mismatch, or an expired match — is a `failure`.
 */
export function evaluateAuditReport(report, allowlistEntries, now = new Date()) {
  const advisories = collectAdvisories(report).filter((advisory) => SEVERITIES_THAT_FAIL.has(advisory.severity));

  const failures = [];
  const ignored = [];
  for (const advisory of advisories) {
    const match =
      advisory.ghsaId &&
      allowlistEntries.find(
        (entry) => entry.ghsaId.toLowerCase() === advisory.ghsaId.toLowerCase() && entry.package === advisory.package,
      );

    if (match && !isExpired(match, now)) {
      ignored.push({ ...advisory, expires: match.expires, issue: match.issue, reason: match.reason });
    } else {
      failures.push({ ...advisory, expiredMatch: Boolean(match) });
    }
  }
  return { failures, ignored };
}

function runNpmAudit() {
  // npm audit exits non-zero whenever it finds anything to report, including advisories this gate will end up
  // ignoring, so the exit code alone is never the pass/fail signal — it is only cross-checked against what was
  // actually parsed, in assertReportIntegrity.
  const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (!result.stdout) {
    throw new Error(`npm audit produced no stdout (exit ${result.status}): ${result.stderr}`);
  }
  return { stdout: result.stdout, status: result.status };
}

/** Parses `npm audit --json`'s stdout, with an error message that names the step that failed. */
export function parseAuditReport(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm audit's output is not valid JSON: ${error.message}`);
  }
}

function main() {
  const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const allowlistPath = path.join(repoRoot, '.audit-allowlist.json');

  let report;
  let npmAuditStatus;
  try {
    const { stdout, status } = runNpmAudit();
    report = parseAuditReport(stdout);
    npmAuditStatus = status;
  } catch (error) {
    process.stderr.write(`::error::dependency-audit: could not read npm audit's report: ${error.message}\n`);
    process.exit(1);
  }

  let allAdvisories;
  try {
    allAdvisories = collectAdvisories(report);
    assertReportIntegrity(report, npmAuditStatus, allAdvisories);
  } catch (error) {
    process.stderr.write(`::error::dependency-audit: ${error.message}\n`);
    process.exit(1);
  }

  let allowlist;
  try {
    allowlist = loadAllowlist(allowlistPath);
  } catch (error) {
    process.stderr.write(`::error::dependency-audit: ${error.message}\n`);
    process.exit(1);
  }

  let failures;
  let ignored;
  try {
    ({ failures, ignored } = evaluateAuditReport(report, allowlist));
  } catch (error) {
    process.stderr.write(`::error::dependency-audit: ${error.message}\n`);
    process.exit(1);
  }

  for (const entry of ignored) {
    process.stdout.write(
      `::notice::dependency-audit: ignoring ${entry.severity} ${entry.package} ${entry.ghsaId} ` +
        `(issue #${entry.issue}, expires ${entry.expires}): ${entry.reason}\n`,
    );
  }

  if (failures.length === 0) {
    process.stdout.write(
      ignored.length > 0
        ? `dependency-audit: 0 unallowed high/critical advisories (${ignored.length} allowlisted, see above)\n`
        : 'dependency-audit: 0 high/critical advisories\n',
    );
    process.exit(0);
  }

  for (const entry of failures) {
    const id = entry.ghsaId ?? '(no GHSA id found in advisory)';
    const reason = entry.expiredMatch ? 'allowlist entry expired' : 'not in .audit-allowlist.json';
    process.stderr.write(`::error::dependency-audit: ${entry.severity} ${entry.package} ${id} — ${reason}\n`);
  }
  process.exit(1);
}

/**
 * True only when this file is the script Node was asked to run — not merely imported by a test. A plain
 * `import.meta.url === \`file://${process.argv[1]}\`` string compare (the previous check here) goes false, and
 * `main()` silently never runs, whenever the two differ only in how they spell the same path: `import.meta.url`
 * is percent-encoded and Node resolves it through any symlink (unless run with `--preserve-symlinks`), while
 * `process.argv[1]` is neither. Comparing resolved `file://` URLs for both sides removes that gap entirely
 * (and matches on Windows, where `file://${argv[1]}` is never a valid URL to begin with).
 */
function isRunAsScript() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false; // argv[1] does not resolve to a real file: this is not that file being run
  }
}

if (isRunAsScript()) {
  main();
}
