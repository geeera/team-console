#!/usr/bin/env node
// Regression test for the deploy.yml guard bug (PR #69 review): a comment mentioning the placeholder id must
// not block a deploy whose real `database_id` is already set, and the guard must still catch the placeholder
// when it is the real `database_id`. Not a Vitest spec: this tool lives outside the Nx graph and only needs
// Node's builtin `assert`, run directly by security.yml's `workflow-lint` job, next to the other tools/* tests.
'use strict';

const assert = require('assert');
const { hasPlaceholderDatabaseId, parseJsonc } = require('./check-d1-placeholder');

const PLACEHOLDER = '00000000-0000-0000-0000-00000000dev1';
const REAL_ID = 'c2aa81dc-a67a-4efb-8eb2-95d02d21aa87';

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

// The exact regression from #69: the placeholder only appears inside a comment, never as a database_id.
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

assert.strictEqual(
  hasPlaceholderDatabaseId(commentOnlyConfig, 'dev', PLACEHOLDER),
  false,
  'placeholder mentioned only in a comment must not fail the guard',
);

assert.strictEqual(
  hasPlaceholderDatabaseId(configWith(PLACEHOLDER), 'dev', PLACEHOLDER),
  true,
  'placeholder as the real database_id must fail the guard',
);

assert.strictEqual(
  hasPlaceholderDatabaseId(configWith(REAL_ID), 'dev', PLACEHOLDER),
  false,
  'a real database_id must not fail the guard',
);

// Trailing commas and mixed comment styles (as used in apps/api/wrangler.jsonc and apps/hooks/wrangler.jsonc)
// must still parse.
const parsed = parseJsonc(configWith(REAL_ID));
assert.strictEqual(parsed.env.dev.d1_databases[0].database_id, REAL_ID);

// A placeholder that is the real id for a *different* environment must not fail the guard for this one.
const multiEnvConfig = `
  {
    "env": {
      "dev": { "d1_databases": [{ "binding": "DB", "database_id": "${REAL_ID}" }] },
      "stage": { "d1_databases": [{ "binding": "DB", "database_id": "00000000-0000-0000-0000-0000000stage" }] }
    }
  }
`;
assert.strictEqual(hasPlaceholderDatabaseId(multiEnvConfig, 'dev', PLACEHOLDER), false);
assert.strictEqual(
  hasPlaceholderDatabaseId(multiEnvConfig, 'stage', '00000000-0000-0000-0000-0000000stage'),
  true,
);

process.stdout.write('ok: check-d1-placeholder distinguishes comments from the real database_id\n');
