import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { ApiEnv } from './env';

declare global {
  namespace Cloudflare {
    interface Env extends ApiEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
