/**
 * The hooks Worker's entry point (threat model C6, #481): signature check and delivery parsing only. Nothing reached
 * from here imports `@worker/github`, so the app's private key handling and token minting never enter the hooks
 * bundle; `tools/workspace-checks/src/hooks-isolation.spec.ts` walks the imports to keep it so.
 */
export { verifyGitHubSignature } from './lib/signature';
export { githubWebhooks, parseGitHubDelivery } from './lib/webhooks';
