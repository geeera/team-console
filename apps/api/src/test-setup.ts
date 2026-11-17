import { applyD1Migrations, env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID } from '@shared/contracts';

// Per test file, on isolated storage: every spec starts from a freshly migrated, empty database.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The account's entitled concurrency (#746) is counted across a file's cases, which share this database and mostly
// claim on the owner's account without finishing: the top of the operator's override range keeps that count out of
// the rules each case is about. The concurrency specs set the entitlement they test on an account of their own.
await env.DB.prepare(`UPDATE accounts SET entitlements = '{"max_concurrency":32}' WHERE id = ?1`)
  .bind(OWNER_ACCOUNT_ID)
  .run();
