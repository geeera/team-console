import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { OWNER_ACCOUNT_ID, isEnrolmentIntentId } from '@shared/contracts';
import { expect } from './fixtures';
import { ru } from './i18n';
import { apiClient, type Stack } from './stack';

/** The add-runner wizard's steps as an owner and a runner walk them (#634 PR 4), shared by its specs. */

export const INTENTS = `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/enrolment-intents`;

export interface Bound {
  readonly fingerprint: string;
  readonly key: KeyObject;
}

/** Opens the wizard from the empty state, names the runner and asks for the command; answers the intent id. */
export async function commandFor(page: Page, name: string): Promise<{ dialog: Locator; intentId: string }> {
  await page.goto('/settings/runners');
  await page.getByTestId('runners-empty').getByTestId('runners-enrol').click();
  const dialog = page.getByRole('dialog', { name: ru('runners.enrol.title') });
  await expect(dialog.getByTestId('wizard-name')).toBeFocused();
  await dialog.getByTestId('wizard-name').fill(name);
  await dialog.getByTestId('wizard-submit').click();
  await expect(
    dialog.getByRole('heading', { name: ru('runners.wizard.command.title', { name }) }),
  ).toBeFocused();
  const command =
    (await dialog.getByTestId('wizard-command').getByTestId('copy-code-text').textContent()) ?? '';
  const intentId = /--enrolment (\S+)$/.exec(command)?.[1] ?? '';
  expect(isEnrolmentIntentId(intentId), command).toBe(true);
  return { dialog, intentId };
}

/** The runner's half of `setup`: a fresh key bound to the intent; the console answers the fingerprint. */
export async function bindAsRunner(
  stack: Stack,
  intentId: string,
  machine: 'mac' | 'linux' = 'mac',
  version = '0.3.0',
): Promise<Bound> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const api = await apiClient(stack);
  try {
    const response = await api.post('/api/v1/runner/enrol/start', {
      data: {
        intentId,
        publicKey: { kty: 'OKP', crv: 'Ed25519', x: publicKey.export({ format: 'jwk' }).x },
        host:
          machine === 'mac'
            ? { os: 'darwin', arch: 'arm64', hostname: 'e2e-wizard.local' }
            : { os: 'linux', arch: 'x64', hostname: 'e2e-build-box' },
        capabilities: { local: true, maxConcurrency: 1 },
        isolation: machine === 'mac' ? 'user' : 'container',
        version,
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    return { fingerprint: ((await response.json()) as { fingerprint: string }).fingerprint, key: privateKey };
  } finally {
    await api.dispose();
  }
}

export async function withApi<T>(stack: Stack, run: (api: APIRequestContext) => Promise<T>): Promise<T> {
  const api = await apiClient(stack);
  try {
    return await run(api);
  } finally {
    await api.dispose();
  }
}
