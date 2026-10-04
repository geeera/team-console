import { MasterKeyError, importMasterKey } from '@worker/core';
import { GitHubError } from '@worker/github';

/** The two subkeys of ADR 0003 decision 4, per environment (HKDF salt), and the master key's id. */
export interface OwnerKeys {
  readonly keyId: string;
  /** `owner-token-v1`: the token pair in D1. */
  readonly tokenKey: CryptoKey;
  /** `oauth-state-v1`: the `state` + PKCE verifier cookie. */
  readonly stateKey: CryptoKey;
}

export const TOKEN_KEY_INFO = 'owner-token-v1';
export const STATE_KEY_INFO = 'oauth-state-v1';

/** 503 `github-auth`: the Worker cannot hold an owner connection; the detail names the binding, never a value. */
export function ownerFlowMisconfigured(detail: string): GitHubError {
  return new GitHubError(
    {
      type: 'github-auth',
      title: 'The GitHub connection is not configured on this Worker',
      status: 503,
      detail,
    },
    null,
  );
}

/** Derives the subkeys from `TOKEN_ENCRYPTION_KEY`; anything but exactly 32 bytes of base64 is a 503, never a weak key. */
export async function loadOwnerKeys(masterKey: string | undefined, environment: string): Promise<OwnerKeys> {
  try {
    const master = await importMasterKey(masterKey);
    return {
      keyId: master.keyId,
      tokenKey: await master.deriveKey(environment, TOKEN_KEY_INFO),
      stateKey: await master.deriveKey(environment, STATE_KEY_INFO),
    };
  } catch (error: unknown) {
    if (error instanceof MasterKeyError) {
      throw ownerFlowMisconfigured('TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded');
    }
    throw error;
  }
}
