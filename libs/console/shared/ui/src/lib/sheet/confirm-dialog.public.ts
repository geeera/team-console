// The public part of `confirm-dialog.ts` (the barrel re-exports whole files, #123): the dialog itself opens only
// through `Sheet.confirm()`.
export { ConfirmFailure } from './confirm-dialog';
export type { ConfirmCheck, ConfirmInput, ConfirmOptions } from './confirm-dialog';
