import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      /** The vendored plugin's version and the SHA-256 of its `ptlib/labels.py` (vitest.config.mts). */
      TEST_PLUGIN_VERSION: string;
      TEST_PLUGIN_LABELS_SHA256: string;
      /** This library's non-test sources by path under `src/` (vitest.config.mts), for source-level guards. */
      TEST_LIBRARY_SOURCES: Record<string, string>;
    }
  }
}
