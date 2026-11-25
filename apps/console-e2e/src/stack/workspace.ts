import { resolve } from 'node:path';

/** The checkout the stack runs from: its `node_modules` holds the wrangler and the workerd every server uses. */
export const WORKSPACE_ROOT = resolve(__dirname, '../../../..');
