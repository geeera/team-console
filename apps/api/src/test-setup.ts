import { applyD1Migrations, env } from 'cloudflare:test';

// Per test file, on isolated storage: every spec starts from a freshly migrated, empty database.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
