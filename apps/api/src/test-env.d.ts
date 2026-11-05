import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { ApiEnv } from './env';

declare global {
  namespace Cloudflare {
    interface Env extends ApiEnv {
      TEST_MIGRATIONS: D1Migration[];
      /** An unmigrated D1 for migrations.spec.ts to migrate one step at a time. */
      MIGRATION_DB: D1Database;
      /** Public half of the generated test app key (vitest.config.mts), to verify the app JWT. */
      TEST_GITHUB_APP_PUBLIC_JWK: string;
    }
  }
}
