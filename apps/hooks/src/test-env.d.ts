import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { HooksEnv } from './env';

declare global {
  namespace Cloudflare {
    interface Env extends HooksEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
