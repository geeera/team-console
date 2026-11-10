import baseConfig from '../../eslint.config.mjs';

/**
 * Threat model C6 (#481): the hooks Worker verifies signatures and holds no GitHub App credentials, so it never
 * imports the app's auth (`@worker/github`) or the VCS adapter that reads through it (the `@worker/vcs-github`
 * barrel); it takes the webhook half from `@worker/vcs-github/webhooks`. Specs are held to it too: a test that
 * needs the app flow belongs to the api Worker.
 */
const message =
  'The hooks Worker holds no GitHub App credentials (threat model C6): import the webhook half from @worker/vcs-github/webhooks.';

// The bare names go in `paths`: as a gitignore-style pattern `@worker/vcs-github` would also exclude everything below
// it, and a negation cannot re-include a file under an excluded directory.
export const hooksRestrictedImports = {
  paths: [
    { name: '@worker/github', message },
    { name: '@worker/vcs-github', message },
  ],
  patterns: [
    { group: ['@worker/github/*', '@worker/vcs-github/*', '!@worker/vcs-github/webhooks'], message },
  ],
};

export default [
  ...baseConfig,
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', hooksRestrictedImports],
    },
  },
];
