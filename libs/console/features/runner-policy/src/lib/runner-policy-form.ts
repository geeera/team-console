import {
  RUNNER_POLICY_FALLBACK_MAX,
  RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS,
  RUNNER_POLICY_OFFLINE_MAX_SECONDS,
  RUNNER_POLICY_OFFLINE_MIN_SECONDS,
  type RunnerPolicy,
} from '@shared/contracts';

/** `inherit` is a project's "use the account default" (`PUT null`); the account itself has no such choice. */
export type PolicyMode = 'inherit' | RunnerPolicy['mode'];

/** The editor's fields as typed; `offlineAfter` stays the text of its input until it is saved. */
export interface PolicyForm {
  readonly mode: PolicyMode;
  readonly pinned: string;
  readonly preferred: string;
  readonly fallback: readonly string[];
  readonly offlineAfter: string;
}

export const EMPTY_POLICY_FORM: PolicyForm = {
  mode: 'any',
  pinned: '',
  preferred: '',
  fallback: [],
  offlineAfter: String(RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS),
};

/** The form a stored policy opens with (`null` is a project on the account default). */
export function policyFormOf(policy: RunnerPolicy | null, canInherit: boolean): PolicyForm {
  if (policy === null) {
    return { ...EMPTY_POLICY_FORM, mode: canInherit ? 'inherit' : 'any' };
  }
  switch (policy.mode) {
    case 'any':
      return EMPTY_POLICY_FORM;
    case 'pinned':
      return { ...EMPTY_POLICY_FORM, mode: 'pinned', pinned: policy.runner };
    case 'failover':
      return {
        ...EMPTY_POLICY_FORM,
        mode: 'failover',
        preferred: policy.preferred,
        fallback: policy.fallback,
        offlineAfter: String(policy.offline_after_seconds),
      };
  }
}

/** Which field is wrong, as the `runners.policy.err.*` copy names it. */
export type PolicyFormError = 'pinned' | 'preferred' | 'fallback' | 'offlineAfter';

export type PolicyFormCheck =
  | { readonly ok: true; readonly policy: RunnerPolicy | null }
  | { readonly ok: false; readonly error: PolicyFormError };

const WHOLE_SECONDS = /^[0-9]{1,6}$/;

/**
 * The body `PUT …/runner-policy` gets, checked the way `checkRunnerPolicy` checks it so the owner hears about a
 * wrong field before anything is sent; the Worker still judges it (and that the runners are the account's, live).
 */
export function policyOfForm(form: PolicyForm): PolicyFormCheck {
  switch (form.mode) {
    case 'inherit':
      return { ok: true, policy: null };
    case 'any':
      return { ok: true, policy: { mode: 'any' } };
    case 'pinned':
      return form.pinned === '' ? { ok: false, error: 'pinned' } : { ok: true, policy: { mode: 'pinned', runner: form.pinned } };
    case 'failover': {
      if (form.preferred === '') {
        return { ok: false, error: 'preferred' };
      }
      const fallback = [...new Set(form.fallback)].filter((id) => id !== form.preferred);
      if (fallback.length === 0 || fallback.length > RUNNER_POLICY_FALLBACK_MAX) {
        return { ok: false, error: 'fallback' };
      }
      const text = form.offlineAfter.trim();
      const seconds = Number(text);
      if (
        !WHOLE_SECONDS.test(text) ||
        seconds < RUNNER_POLICY_OFFLINE_MIN_SECONDS ||
        seconds > RUNNER_POLICY_OFFLINE_MAX_SECONDS
      ) {
        return { ok: false, error: 'offlineAfter' };
      }
      return {
        ok: true,
        policy: { mode: 'failover', preferred: form.preferred, fallback, offline_after_seconds: seconds },
      };
    }
  }
}

/** Moves one fallback a place up (`-1`) or down (`+1`); the first and last stay where they are. */
export function moveFallback(fallback: readonly string[], index: number, by: -1 | 1): readonly string[] {
  const target = index + by;
  if (index < 0 || index >= fallback.length || target < 0 || target >= fallback.length) {
    return fallback;
  }
  const next = [...fallback];
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) {
    next.splice(target, 0, moved);
  }
  return next;
}
