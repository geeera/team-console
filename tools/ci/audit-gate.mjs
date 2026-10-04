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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const GHSA_RE = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i;
const SEVERITIES_THAT_FAIL = new Set(['high', 'critical']);

function extractGhsaId(url) {
  if (typeof url !== 'string') return null;
  const match = GHSA_RE.exec(url);
  return match ? match[0] : null;
}

/**
 * Walks `npm audit --json`'s `vulnerabilities` map and returns one entry per distinct (GHSA id, package) pair
 * found in a `via` array. `via` mixes two shapes: an advisory object (direct finding, has `url`/`severity`/
 * `name`) and a plain package-name string (this package is vulnerable only because it depends on that other
 * package, whose own entry in the map carries the real advisory) — only the object shape is a reportable
 * advisory; the string shape is skipped here and picked up from that other package's own entry instead.
 *
 * An advisory object that is missing a `url` (so no GHSA id can be extracted) still appears in the result
 * with `ghsaId: null`: the gate below never matches a `null` id against the allowlist, so an advisory whose id
 * cannot be determined fails closed instead of being silently skipped.
 */
function collectAdvisories(report) {
  const vulnerabilities = report?.vulnerabilities;
  if (typeof vulnerabilities !== 'object' || vulnerabilities === null) {
    throw new Error('npm audit report has no "vulnerabilities" object');
  }

  const advisories = new Map();
  for (const pkgReport of Object.values(vulnerabilities)) {
    const via = Array.isArray(pkgReport?.via) ? pkgReport.via : [];
    for (const entry of via) {
      if (typeof entry !== 'object' || entry === null) continue; // a package-name string, not an advisory

      const ghsaId = extractGhsaId(entry.url);
      const pkg = typeof entry.name === 'string' ? entry.name : pkgReport?.name;
      const severity = typeof entry.severity === 'string' ? entry.severity : pkgReport?.severity;
      if (typeof pkg !== 'string' || typeof severity !== 'string') continue; // nothing to key this advisory on

      const key = `${ghsaId ?? '(unidentified)'}|${pkg}|${entry.url ?? ''}`;
      if (!advisories.has(key)) {
        advisories.set(key, { ghsaId, package: pkg, severity, url: entry.url ?? null, title: entry.title ?? null });
      }
    }
  }
  return [...advisories.values()];
}

function loadAllowlist(filePath) {
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

  return entries.map((entry, index) => {
    for (const field of ['ghsaId', 'package', 'reason', 'issue', 'expires']) {
      if (!(field in entry)) {
        throw new Error(`${filePath} entries[${index}] is missing required field "${field}"`);
      }
    }
    if (Number.isNaN(Date.parse(`${entry.expires}T00:00:00Z`))) {
      throw new Error(`${filePath} entries[${index}].expires ("${entry.expires}") is not a valid ISO date`);
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
  // ignoring, so the exit code is not the signal here — only the JSON on stdout is parsed.
  const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (!result.stdout) {
    throw new Error(`npm audit produced no stdout (exit ${result.status}): ${result.stderr}`);
  }
  return result.stdout;
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
  try {
    report = parseAuditReport(runNpmAudit());
  } catch (error) {
    process.stderr.write(`::error::dependency-audit: could not read npm audit's report: ${error.message}\n`);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
