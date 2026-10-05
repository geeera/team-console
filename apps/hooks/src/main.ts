import { createHooksApp } from './app';
import type { HooksEnv } from './env';

const app = createHooksApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<HooksEnv>;
