#!/usr/bin/env node
// deploy.yml's "Verify the runner release the console names" step (S1 of the #634 security note, threat model C11
// R-ONE-2). `RUNNER_RELEASE_VERSION` and `RUNNER_RELEASE_SHA256SUMS` are vars in apps/api/wrangler.jsonc, so any
// merged PR can change them; the console builds the first-install command from them, and that command's checksum is
// all a fresh Mac can check. So before the Worker ships, the release's own `SHA256SUMS` is downloaded from the pinned
// repository, `gh attestation verify` proves the pinned release workflow built it from that version's tag, and the
// var must equal it byte for byte. Whoever edits the vars can then only break the deploy, never name another tarball.
// The Linux one command (#634 PR 7, R-LNX) pulls the runner image by `RUNNER_RELEASE_IMAGE_DIGEST`: the same
// `gh attestation verify`, against `oci://<image>@<digest>`, proves the release workflow built that digest from the
// version's tag, so an edited digest cannot name another image either.
//
//   node check-runner-release.js <env> <wrangler.jsonc>              the full check (deploy.yml's guard job)
//   node check-runner-release.js --format-only <env> <wrangler.jsonc> shape only, no network (security.yml, per PR)
//
// Fails closed: a version without sums, sums without a version, a malformed value, a failed download or
// verification, or any difference stops the deploy. The identity flags mirror `attestationVerifyArgs` in
// libs/shared/contracts/src/lib/runner-release.ts (tools/workspace-checks/src/runner-release-guard.spec.ts keeps them
// equal); no npm dependency, so it runs in the cheap `guard` job before `npm ci`.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseJsonc } = require('./check-d1-placeholder');

const RELEASE_HOST = 'github.com';
const RELEASE_REPOSITORY = 'geeera/team-console';
const RELEASE_WORKFLOW_PATH = '.github/workflows/release-runner.yml';
const RELEASE_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const RELEASE_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
const RELEASE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const SUMS_LINE = /^[0-9a-f]{64} {2}(\S+)$/;
// `RUNNER_IMAGE` of libs/shared/contracts/src/lib/runner-linux.ts and `IMAGE` of release-runner.yml.
const RUNNER_IMAGE = `ghcr.io/${RELEASE_REPOSITORY}-runner`;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The image `gh attestation verify` checks: by digest, never by tag. */
function imageSubjectOf(digest) {
  return `oci://${RUNNER_IMAGE}@${digest}`;
}

function attestationArgs(asset, version) {
  return [
    'attestation',
    'verify',
    asset,
    '--hostname',
    RELEASE_HOST,
    '--repo',
    RELEASE_REPOSITORY,
    '--signer-workflow',
    `${RELEASE_HOST}/${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}`,
    '--source-ref',
    `refs/tags/v${version}`,
    '--cert-oidc-issuer',
    RELEASE_OIDC_ISSUER,
    '--predicate-type',
    RELEASE_PREDICATE_TYPE,
    '--deny-self-hosted-runners',
  ];
}

function downloadArgs(version, dir) {
  return ['release', 'download', `v${version}`, '--repo', `${RELEASE_HOST}/${RELEASE_REPOSITORY}`, '--pattern', 'SHA256SUMS', '--dir', dir];
}

/** The tarball names `SHA256SUMS` lists for `version`, in `sha256sum -- *.tar.gz` order. */
function tarballNamesOf(version) {
  return PLATFORMS.map((platform) => `team-console-runner-${version}-${platform}.tar.gz`).sort();
}

/** The three vars of `envName`, as strings; a missing one is an error, an empty one is "unset". */
function releaseVarsOf(source, envName) {
  const vars = parseJsonc(source)?.env?.[envName]?.vars;
  if (typeof vars !== 'object' || vars === null) {
    throw new Error(`'env.${envName}.vars' is missing`);
  }
  const version = vars.RUNNER_RELEASE_VERSION;
  const sums = vars.RUNNER_RELEASE_SHA256SUMS;
  const imageDigest = vars.RUNNER_RELEASE_IMAGE_DIGEST;
  if (typeof version !== 'string' || typeof sums !== 'string' || typeof imageDigest !== 'string') {
    throw new Error(
      `'env.${envName}.vars' must set RUNNER_RELEASE_VERSION, RUNNER_RELEASE_SHA256SUMS and RUNNER_RELEASE_IMAGE_DIGEST (each may be "")`,
    );
  }
  return { version, sums, imageDigest };
}

/**
 * `null` when no release is named; otherwise the version, after the shape of every value is checked. The image digest
 * is optional with a release (the Linux command is then not offered) and never set without one.
 */
function namedRelease({ version, sums, imageDigest = '' }) {
  if (imageDigest !== '' && !IMAGE_DIGEST.test(imageDigest)) {
    throw new Error(`RUNNER_RELEASE_IMAGE_DIGEST ${JSON.stringify(imageDigest)} must be sha256:<64 lower-case hex>, the digest the release notes name`);
  }
  if (version === '' && sums === '') {
    if (imageDigest !== '') {
      throw new Error('RUNNER_RELEASE_IMAGE_DIGEST is set but RUNNER_RELEASE_VERSION is empty: clear it or name its release');
    }
    return null;
  }
  if (version === '') {
    throw new Error('RUNNER_RELEASE_SHA256SUMS is set but RUNNER_RELEASE_VERSION is empty: clear both or set both');
  }
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(`RUNNER_RELEASE_VERSION ${JSON.stringify(version)} is not a release version`);
  }
  if (sums === '') {
    throw new Error(`RUNNER_RELEASE_VERSION is ${version} but RUNNER_RELEASE_SHA256SUMS is empty: paste that release's SHA256SUMS`);
  }
  const lines = sums.endsWith('\n') ? sums.slice(0, -1).split('\n') : null;
  const names = tarballNamesOf(version);
  const wellFormed =
    lines !== null &&
    lines.length === names.length &&
    lines.every((line, index) => SUMS_LINE.exec(line)?.[1] === names[index]);
  if (!wellFormed) {
    throw new Error(
      `RUNNER_RELEASE_SHA256SUMS must be the release's SHA256SUMS text: one "<64 hex>  <tarball>" line for each of ${names.join(', ')}, each ending in \\n`,
    );
  }
  return version;
}

/** Downloads the release's `SHA256SUMS`, has gh verify its attestation, and compares it with the var. */
function verifyAgainstRelease(version, sums, gh = execFileSync) {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'runner-release-'));
  try {
    gh('gh', downloadArgs(version, dir), { stdio: 'inherit' });
    const file = path.join(dir, 'SHA256SUMS');
    gh('gh', attestationArgs(file, version), { stdio: 'inherit' });
    const published = fs.readFileSync(file, 'utf8');
    if (published !== sums) {
      throw new Error(
        `RUNNER_RELEASE_SHA256SUMS differs from the attested SHA256SUMS of v${version}; the attested value is ${JSON.stringify(published)}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Has gh verify the image digest's provenance with the same identity: built by the pinned workflow from `v<version>`. */
function verifyImage(version, imageDigest, gh = execFileSync) {
  gh('gh', attestationArgs(imageSubjectOf(imageDigest), version), { stdio: 'inherit' });
}

module.exports = {
  RUNNER_IMAGE,
  attestationArgs,
  downloadArgs,
  imageSubjectOf,
  namedRelease,
  releaseVarsOf,
  tarballNamesOf,
  verifyAgainstRelease,
  verifyImage,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const formatOnly = args[0] === '--format-only';
  const [envName, file] = formatOnly ? args.slice(1) : args;
  try {
    if (envName === undefined || file === undefined) {
      throw new Error('usage: check-runner-release.js [--format-only] <env> <wrangler.jsonc>');
    }
    const vars = releaseVarsOf(fs.readFileSync(file, 'utf8'), envName);
    const version = namedRelease(vars);
    if (version === null) {
      console.log(`::notice::${envName}: no runner release named; the console offers no install one-liner`);
    } else if (formatOnly) {
      console.log(`${envName}: runner release ${version} and its sums are well formed (attestation is checked at deploy)`);
    } else {
      verifyAgainstRelease(version, vars.sums);
      console.log(`::notice::${envName}: RUNNER_RELEASE_SHA256SUMS is the attested SHA256SUMS of v${version}`);
      if (vars.imageDigest === '') {
        console.log(`::notice::${envName}: no runner image digest named; the console offers no Linux command`);
      } else {
        verifyImage(version, vars.imageDigest);
        console.log(`::notice::${envName}: RUNNER_RELEASE_IMAGE_DIGEST is the attested runner image of v${version}`);
      }
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
