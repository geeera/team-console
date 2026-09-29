#!/usr/bin/env node
// deploy.yml's "Guard against placeholder D1 database ids" step (regression guard for #25).
//
// A plain `grep` for the placeholder UUID against the whole wrangler.jsonc file matches it anywhere in the
// file, including inside a comment that only *describes* the placeholder (that gap let PR #69's comment on
// the real `database_id` block for dev trip the guard and block every dev deploy — see #<issue>). This parses
// the JSONC the same shape wrangler itself reads, and only ever compares `env.<env>.d1_databases[].database_id`.
//
// No npm dependency: this runs in the `guard` job before `npm ci` (the cheap job that must fail in seconds,
// not after a full Nx build), so parsing is a small dependency-free JSONC reader (strip `//`/`/* */` comments
// and trailing commas, string-aware) rather than pulling in `wrangler` or a JSONC package.
'use strict';

const fs = require('node:fs');

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Removes `//` and `/* *\/` comments, copying string contents (escapes included) verbatim. */
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

/** Every `database_id` wrangler would actually read for `envName` from a parsed wrangler.jsonc. */
function collectDatabaseIds(config, envName) {
  const d1Databases = config?.env?.[envName]?.d1_databases;
  if (!Array.isArray(d1Databases)) {
    return [];
  }
  return d1Databases.map((db) => db?.database_id).filter((id) => typeof id === 'string');
}

/** True if `envName`'s real `database_id` (not a comment, not another env) is still the placeholder. */
function hasPlaceholderDatabaseId(source, envName, placeholder) {
  const config = parseJsonc(source);
  return collectDatabaseIds(config, envName).includes(placeholder);
}

module.exports = { hasPlaceholderDatabaseId, parseJsonc, collectDatabaseIds };

if (require.main === module) {
  const [envName, placeholder, ...configPaths] = process.argv.slice(2);
  if (!envName || !placeholder || configPaths.length === 0) {
    process.stderr.write('usage: check-d1-placeholder.js <envName> <placeholder> <configPath...>\n');
    process.exit(2);
  }

  let failed = false;
  for (const configPath of configPaths) {
    const source = fs.readFileSync(configPath, 'utf8');
    if (hasPlaceholderDatabaseId(source, envName, placeholder)) {
      process.stderr.write(
        `::error::${configPath} still has the placeholder D1 database_id for '${envName}'. Create the D1 ` +
          'database (owner checklist) and replace the id by PR before this workflow may deploy (see #25).\n',
      );
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}
