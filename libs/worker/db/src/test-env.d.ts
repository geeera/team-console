import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      /** The vendored plugin's version and the SHA-256 of its `ptlib/labels.py` (vitest.config.mts). */
      TEST_PLUGIN_VERSION: string;
      TEST_PLUGIN_LABELS_SHA256: string;
    }
  }
}
