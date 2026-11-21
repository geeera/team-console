import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, fakePost, ownerCallbackLanding, seed } from './support/stack';

/**
 * #890 on the mock stack: the owner login comes back from GitHub under another user id than the connected one. The
 * callback refuses it with its own outcome, and Settings keeps the connection and says how to switch.
 */
test.describe.configure({ mode: 'serial' });

// The fake's signed-in user while the stack runs (local-stack.ts MOCK_OWNER); restored after the swap.
const MOCK_OWNER = { login: 'geeera', id: 100_001 } as const;
const OTHER_ACCOUNT = { login: MOCK_OWNER.login, id: 424_242 } as const;

test('a different GitHub account under the owner login is refused and Settings says to disconnect first', async ({
  page,
  stack,
}) => {
  requireLocalStack(stack);
  await seed(stack, []);
  const api = await apiClient(stack);
  let landing: string;
  try {
    await fakePost(stack, '/_fake/user', OTHER_ACCOUNT);
    landing = await ownerCallbackLanding(api, stack);
  } finally {
    await fakePost(stack, '/_fake/user', MOCK_OWNER);
    await api.dispose();
  }
  expect(landing).toBe('/settings?github=user-id-changed');

  await page.goto(landing);

  const notice = page.getByTestId('gh-user-id-changed');
  await expect(notice).toHaveAttribute('role', 'alert');
  await expect(notice.getByRole('heading')).toHaveText(ru('settings.gh.idChanged.title'));
  await expect(notice).toContainText(ru('settings.gh.idChanged.body', { login: MOCK_OWNER.login }));
  await expect(notice.getByRole('heading')).toBeFocused();
  // The stored connection is untouched: still connected, with Disconnect as the way to switch.
  await expect(page.getByTestId('gh-connected')).toContainText(
    ru('settings.gh.connected', { login: MOCK_OWNER.login }),
  );
  await expect(
    page.getByRole('button', { name: ru('settings.gh.disconnectAria', { login: MOCK_OWNER.login }) }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  await expectAccessible(page, 'settings, a different GitHub account refused');
});
