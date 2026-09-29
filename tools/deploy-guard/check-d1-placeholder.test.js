#!/usr/bin/env node
// Regression test for the deploy.yml guard bug (PR review): a comment mentioning the placeholder id must not
// block a deploy whose real `database_id` is already set, the guard must still catch the placeholder when it
// is the real `database_id`, and (SECURITY review) it must fail closed on any shape it cannot fully validate
// instead of silently treating "no placeholder found" as "safe to deploy". Not a Vitest spec: this tool lives
// outside the Nx graph and only needs Node's builtin `assert`, run directly by security.yml's `workflow-lint`
// job, next to the other tools/* tests.
'use strict';

const assert = require('assert');
const { assertNoPlaceholderDatabaseId, parseJsonc } = require('./check-d1-placeholder');

const PLACEHOLDER = '00000000-0000-0000-0000-00000000dev1';
const REAL_ID = 'c2aa81dc-a67a-4efb-8eb2-95d02d21aa87';

function assertOk(source, envName, placeholder, message) {
  assertNoPlaceholderDatabaseId(source, envName, placeholder);
  // no throw: pass
  void message;
}

function assertFails(source, envName, placeholder, message) {
  assert.throws(() => assertNoPlaceholderDatabaseId(source, envName, placeholder), Error, message);
}

function configWith(databaseId) {
  return `
    // Real D1 database id (#25; not a secret) — deploy.yml's guard fails the deploy if this ever regresses
    // to the scaffold placeholder that shipped before the real one landed.
    {
      "env": {
        "dev": {
          "d1_databases": [
            {
              "binding": "DB",
              "database_id": "${databaseId}",
              "migrations_dir": "migrations",
            },
          ],
        },
      },
    }
  `;
}

// --- The exact regression: the placeholder only appears inside a comment, never as a database_id. ---
const commentOnlyConfig = `
  // A scaffold placeholder id (before #25 filled it) looked like "${PLACEHOLDER}".
  {
    "env": {
      "dev": {
        "d1_databases": [
          { "binding": "DB", "database_id": "${REAL_ID}", "migrations_dir": "migrations" }
        ]
      }
    }
  }
`;
assertOk(commentOnlyConfig, 'dev', PLACEHOLDER, 'placeholder mentioned only in a comment must not fail the guard');

// --- True positives. ---
assertFails(configWith(PLACEHOLDER), 'dev', PLACEHOLDER, 'placeholder as the real database_id must fail the guard');
assertOk(configWith(REAL_ID), 'dev', PLACEHOLDER, 'a real database_id must not fail the guard');

// A placeholder in a *second* d1_databases entry must also be caught, not just index 0.
const secondEntryConfig = `
  {
    "env": {
      "dev": {
        "d1_databases": [
          { "binding": "DB", "database_id": "${REAL_ID}" },
          { "binding": "OTHER", "database_id": "${PLACEHOLDER}" }
        ]
      }
    }
  }
`;
assertFails(secondEntryConfig, 'dev', PLACEHOLDER, 'placeholder in a second d1_databases entry must fail the guard');

// The placeholder comparison is case-insensitive.
assertFails(
  configWith(PLACEHOLDER.toUpperCase()),
  'dev',
  PLACEHOLDER,
  'an uppercased placeholder must still fail the guard',
);

// --- Fail-closed: any shape the guard cannot fully validate is treated as unsafe, not as "not the placeholder". ---
assertFails('{ "env": {} }', 'dev', PLACEHOLDER, 'a missing env block must fail closed');
assertFails('{ "env": { "dev": {} } }', 'dev', PLACEHOLDER, 'a missing d1_databases must fail closed');
assertFails(
  '{ "env": { "dev": { "d1_databases": [] } } }',
  'dev',
  PLACEHOLDER,
  'an empty d1_databases array must fail closed',
);
assertFails(
  '{ "env": { "dev": { "d1_databases": {} } } }',
  'dev',
  PLACEHOLDER,
  'a d1_databases that is an object instead of an array must fail closed',
);
assertFails(
  '{ "env": { "dev": { "d1_databases": [ { "binding": "DB" } ] } } }',
  'dev',
  PLACEHOLDER,
  'a d1_databases entry missing database_id must fail closed',
);
assertFails(
  '{ "env": { "dev": { "d1_databases": [ { "database_id": 123 } ] } } }',
  'dev',
  PLACEHOLDER,
  'a non-string database_id must fail closed',
);
assertFails(
  '{ "env": { "dev": { "d1_databases": [ { "database_id": "not-a-uuid" } ] } } }',
  'dev',
  PLACEHOLDER,
  'a database_id that is not a UUID must fail closed',
);

// `Object.hasOwn` is used (not `in`/optional chaining alone) so a prototype property can never be mistaken
// for a real env block, even though ENV_NAME is allowlisted upstream and this is not reachable today.
assertFails('{ "env": {} }', 'toString', PLACEHOLDER, 'an inherited Object.prototype member must not count as an env block');

// --- Crafted strings that must not be mistaken for a comment or a trailing comma. ---
const craftedStringsConfig = `
  {
    "env": {
      "dev": {
        "d1_databases": [
          { "binding": "DB", "note": "http://a/*b", "database_id": "${REAL_ID}" }
        ],
        "other": ", }"
      }
    }
  }
`;
assertOk(craftedStringsConfig, 'dev', PLACEHOLDER, '// and /* inside string values must not be treated as comments');

const escapedQuoteConfig = `
  {
    // a string ending in an escaped quote, immediately followed by a // comment
    "env": { "dev": { "d1_databases": [ { "binding": "DB", "note": "a\\"", "database_id": "${REAL_ID}" } ] } } // trailing
  }
`;
assertOk(escapedQuoteConfig, 'dev', PLACEHOLDER, 'an escaped quote must not end the string early');

// --- Malformed input fails closed instead of silently parsing to something usable. ---
assertFails('{ "env": { "dev": "unterminated', 'dev', PLACEHOLDER, 'an unterminated string must fail closed');
assertFails(
  '{ /* unterminated block comment',
  'dev',
  PLACEHOLDER,
  'an unterminated block comment must fail closed',
);
assert.throws(() => parseJsonc('{ "a": "unterminated'), /unterminated string/);
assert.throws(() => parseJsonc('/* unterminated'), /unterminated \/\* block comment/);

// Trailing commas (as used in apps/api/wrangler.jsonc and apps/hooks/wrangler.jsonc) must still parse.
const parsed = parseJsonc(configWith(REAL_ID));
assert.strictEqual(parsed.env.dev.d1_databases[0].database_id, REAL_ID);

// A placeholder that is the real id for a *different* environment must not fail the guard for this one.
const multiEnvConfig = `
  {
    "env": {
      "dev": { "d1_databases": [{ "binding": "DB", "database_id": "${REAL_ID}" }] },
      "stage": { "d1_databases": [{ "binding": "DB", "database_id": "00000000-0000-0000-0000-0000000stag" }] }
    }
  }
`;
assertOk(multiEnvConfig, 'dev', PLACEHOLDER, 'a placeholder for another env must not fail this env');

process.stdout.write('ok: check-d1-placeholder fails closed and distinguishes comments from the real database_id\n');
