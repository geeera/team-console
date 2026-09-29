#!/usr/bin/env node
// deploy.yml's "Guard against placeholder D1 database ids" step (regression guard for #25).
//
// A plain `grep` for the placeholder UUID against the whole wrangler.jsonc file matches it anywhere in the
// file, including inside a comment that only *describes* the placeholder (that gap let a PR's comment on the
// real `database_id` block for dev trip the guard and block every dev deploy). This parses the JSONC the same
// shape wrangler itself reads, and only ever compares `env.<env>.d1_databases[].database_id`.
//
// No npm dependency: this runs in the `guard` job before `npm ci` (the cheap job that must fail in seconds,
// not after a full Nx build), so parsing is a small dependency-free JSONC reader (strip `//`/`/* */` comments
// and trailing commas, string-aware) rather than pulling in `wrangler` or a JSONC package.
//
// Fails closed (SECURITY review on the PR that introduced this file): this is the one guard standing between
// a config regression and the credentialed `deploy` job, so an unexpected shape — a missing env block, a
// missing/empty `d1_databases`, a non-UUID or non-string `database_id` — is treated the same as finding the
// placeholder, not silently waved through. A denylist of one exact string only catches that one string.
'use strict';

const fs = require('node:fs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Removes `//` and `/* *\/` comments, copying string contents (escapes included) verbatim. Throws if the
 * input ends mid-string or mid-comment: wrangler/JSON.parse would reject such a file anyway, and a parser that
 * guards a deploy must not silently accept malformed input it cannot fully account for.
 */
function stripComments(source) {
  let output = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        output += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      output += ch;
      if (ch === '\\') {
        output += source[i + 1] ?? '';
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      output += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    output += ch;
  }

  if (inString) {
    throw new Error('unterminated string literal at end of input');
  }
  if (inBlockComment) {
    throw new Error('unterminated /* block comment at end of input');
  }

  return output;
}

/** Drops a comma that is only followed (across whitespace) by `}` or `]`, string-aware. */
function removeTrailingCommas(source) {
  let output = '';
  let inString = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      output += ch;
      if (ch === '\\') {
        output += source[i + 1] ?? '';
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      output += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < source.length && isWhitespace(source[j])) {
        j++;
      }
      if (source[j] === '}' || source[j] === ']') {
        continue;
      }
    }
    output += ch;
  }

  return output;
}

function parseJsonc(source) {
  return JSON.parse(removeTrailingCommas(stripComments(source)));
}

/**
 * Throws a descriptive Error unless `envName`'s `d1_databases` in `source` is a non-empty array of entries
 * that each have a `database_id` matching a lowercase UUID and are not the placeholder (case-insensitive).
 * Any other shape — missing env block, missing/empty/non-array `d1_databases`, a missing or malformed
 * `database_id` — fails closed with its own error rather than being treated as "no placeholder found".
 */
function assertNoPlaceholderDatabaseId(source, envName, placeholder) {
  const config = parseJsonc(source);

  const env = config?.env;
  if (typeof env !== 'object' || env === null || !Object.hasOwn(env, envName)) {
    throw new Error(`'env.${envName}' block is missing`);
  }

  const d1Databases = env[envName]?.d1_databases;
  if (!Array.isArray(d1Databases) || d1Databases.length === 0) {
    throw new Error(`'env.${envName}.d1_databases' is missing, empty, or not an array`);
  }

  const lowerPlaceholder = placeholder.toLowerCase();
  d1Databases.forEach((db, index) => {
    const id = db?.database_id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new Error(
        `'env.${envName}.d1_databases[${index}].database_id' is missing or is not a lowercase UUID`,
      );
    }
    if (id.toLowerCase() === lowerPlaceholder) {
      throw new Error(`'env.${envName}.d1_databases[${index}].database_id' is still the placeholder`);
    }
  });
}

module.exports = { assertNoPlaceholderDatabaseId, parseJsonc, UUID_RE };

if (require.main === module) {
  const [envName, placeholder, ...configPaths] = process.argv.slice(2);
  if (!envName || !placeholder || configPaths.length === 0) {
    process.stderr.write('usage: check-d1-placeholder.js <envName> <placeholder> <configPath...>\n');
    process.exit(2);
  }

  let failed = false;
  for (const configPath of configPaths) {
    try {
      const source = fs.readFileSync(configPath, 'utf8');
      assertNoPlaceholderDatabaseId(source, envName, placeholder);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `::error::${configPath} failed the D1 database_id guard for '${envName}': ${reason}. Create the D1 ` +
          'database (owner checklist) and set a real database_id by PR before this workflow may deploy (see the owner checklist / #25).\n',
      );
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}
