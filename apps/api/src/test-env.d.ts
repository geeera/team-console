import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { ApiEnv } from './env';

declare global {
  namespace Cloudflare {
    interface Env extends ApiEnv {
      TEST_MIGRATIONS: D1Migration[];
      /** Public half of the generated test app key (vitest.config.mts), to verify the app JWT. */
      TEST_GITHUB_APP_PUBLIC_JWK: string;
    }
  }
}
