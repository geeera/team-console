import { createApiApp } from './app';
import type { ApiEnv } from './env';

const app = createApiApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<ApiEnv>;
