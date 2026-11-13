import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { ApiEnv } from './env';

declare global {
  namespace Cloudflare {
    interface Env extends ApiEnv {
      TEST_MIGRATIONS: D1Migration[];
      /** An unmigrated D1 for migrations.spec.ts to migrate one step at a time. */
      MIGRATION_DB: D1Database;
      /** Another unmigrated D1, for the 0016 approval backfill (#452). */
      MIGRATION_DB_0016: D1Database;
      /** Unmigrated D1s for the 0018 owner backfill (#465): one owner connection, none, two different users. */
      MIGRATION_DB_0018: D1Database;
      MIGRATION_DB_0018_NO_OWNER: D1Database;
      MIGRATION_DB_0018_AMBIGUOUS: D1Database;
      /** Another, for the 0019 rebuild of `item_events` and `idempotency_keys` (#462). */
      MIGRATION_DB_0019: D1Database;
      /** Another, for 0025's pr-link index over an existing duplicate link (#529). */
      MIGRATION_DB_0025: D1Database;
      /** Another, for 0026's sprint title index over existing repeated titles (#545). */
      MIGRATION_DB_0026: D1Database;
      /** Another, for 0027's trimmed re-key of sprint title keys (#554). */
      MIGRATION_DB_0027: D1Database;
      /** Another, for 0028's runner pause columns over an existing runner (#571). */
      MIGRATION_DB_0028: D1Database;
      /** Another, for 0029's rank backfill and `item_events` rebuild (#456). */
      MIGRATION_DB_0029: D1Database;
      /** Public half of the generated test app key (vitest.config.mts), to verify the app JWT. */
      TEST_GITHUB_APP_PUBLIC_JWK: string;
    }
  }
}
