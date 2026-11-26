import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { press } from './support/press';
import {
  emulatePush,
  fakePushDeliveries,
  fakePushDevice,
  pushAlreadyOn,
  pushRecord,
  storedPushDevices,
  tapNotification,
} from './support/push';
import { seed } from './support/stack';

/**
 * Web push on this device (#36, #174), end to end against the local stack: Settings › Notifications turns push on and
 * off through the api, the test notification is really encrypted for this device and decrypted by the fake push
 * service, and a tapped notification (Angular's worker message, `support/push.ts`) opens its card in place. The
 * browser's push side is emulated; nothing reaches a real push service (the suite's outside-request guard holds).
 */

const PUSH_TEST = '/api/v1/push/test';
const QUESTIONS = '/p/team-console/questions';

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('Turn on: nothing is asked on load, one tap asks once and the api stores this device', async ({
  page,
  context,
  stack,
}) => {
  const subscription = await fakePushDevice(stack);
  await emulatePush(context, subscription, { permission: 'default', isSubscribed: false });

  await page.goto('/settings');
  const off = page.getByTestId('push-off');
  await expect(off).toBeVisible();
  await expect(off.getByRole('heading', { name: ru('push.off.title') })).toBeVisible();
  expect((await pushRecord(page)).prompts, 'no permission prompt on load').toBe(0);
  expect(await storedPushDevices(stack)).toBe(0);
  await expectAccessible(page, 'Settings, Notifications off');

  await press(off.getByRole('button', { name: ru('push.enable') }));

  const on = page.getByTestId('push-on');
  await expect(on).toBeVisible();
  await expect(on.getByRole('heading', { name: ru('push.on.title') })).toBeFocused();
  const record = await pushRecord(page);
  expect(record.prompts, 'one prompt, from the tap').toBe(1);
  expect(record.permission).toBe('granted');
  const config = await page.request.get('/api/v1/push/config');
  expect(record.serverKey, 'subscribed with the api VAPID key').toBe(
    ((await config.json()) as { publicKey: string }).publicKey,
  );
  expect(await storedPushDevices(stack)).toBe(1);
  await expectAccessible(page, 'Settings, Notifications on');
});

test('«Прислать тестовое» reaches this device decrypted and opens Needs you; a second within 30 s is refused', async ({
  page,
  context,
  stack,
}) => {
  const { endpoint } = await pushAlreadyOn(stack, context);
  await page.goto('/settings');
  const on = page.getByTestId('push-on');
  await expect(on).toBeVisible();

  const send = on.getByRole('button', { name: ru('push.test.send') });
  await press(send);
  await expect(on.getByTestId('push-test-sent')).toContainText(ru('push.test.sent'));

  const deliveries = await fakePushDeliveries(stack, endpoint);
  expect(deliveries).toHaveLength(1);
  const [delivery] = deliveries;
  expect(delivery?.outcome).toBe('ok');
  expect(delivery?.decryptError).toBeNull();
  expect(delivery?.payload).toMatchObject({
    notification: {
      title: expect.any(String),
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: '/needs-you' } } },
    },
  });

  const answers: number[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === PUSH_TEST) {
      answers.push(response.status());
    }
  });
  await press(send);
  const [before, after] = ru('push.test.wait', { s: '\u0000' }).split('\u0000');
  const wait = on.getByTestId('push-test-wait');
  await expect(wait).toHaveText(
    new RegExp(`^${escapeRegExp(before ?? '')}([1-9]|[12]\\d|30)${escapeRegExp(after ?? '')}$`),
  );
  expect(answers).toEqual([429]);
  expect(await fakePushDeliveries(stack, endpoint), 'the refused test sends nothing').toHaveLength(1);
  await expectAccessible(page, 'Settings, test push refused');
});

test('a tapped notification opens its card in place: in view, ringed, title focused; junk is ignored', async ({
  page,
  context,
  stack,
}) => {
  await pushAlreadyOn(stack, context);
  await page.goto('/needs-you');
  await expect(page.locator('[data-row="team-console#72"]')).toBeVisible();

  for (const number of [72, 46]) {
    await tapNotification(page, `${QUESTIONS}#${number}`);
    await expect(page).toHaveURL(new RegExp(`${QUESTIONS}#${number}$`));
    const card = page.locator(`[data-row="team-console#${number}"] tc-card`);
    await expect(card).toHaveClass(/\btc-arrival\b/);
    await expect(card.locator('[tc-card-title]')).toBeFocused();
    await expect(card).toBeInViewport();
    await expect(page.locator('.tc-arrival'), 'one ring at a time').toHaveCount(1);
  }

  const url = page.url();
  await tapNotification(page, `${QUESTIONS}#abc`);
  // A rejected target routes nowhere; give a would-be navigation the time a real one above took.
  await page.waitForTimeout(500);
  expect(page.url()).toBe(url);
  await expect(page.locator('[data-row="team-console#46"] [tc-card-title]')).toBeFocused();
  await expect(page.getByTestId('push-gone')).toHaveCount(0);

  await tapNotification(page, `${QUESTIONS}#9999`);
  const gone = page.getByTestId('push-gone');
  await expect(gone).toBeVisible();
  await expect(gone).toBeFocused();
  await expect(gone.getByRole('heading', { name: ru('push.arrive.goneTitle', { n: 9999 }) })).toBeVisible();
  await expect(page.locator('.tc-arrival')).toHaveCount(1);
  await expect(gone).toHaveClass(/\btc-arrival\b/);
  await expectAccessible(page, 'Questions, a tapped number that no longer waits');
});

test('«Выключить» drops this device on the server and in the browser', async ({ page, context, stack }) => {
  await pushAlreadyOn(stack, context);
  await page.goto('/settings');
  const on = page.getByTestId('push-on');
  await expect(on).toBeVisible();
  expect(await storedPushDevices(stack)).toBe(1);

  await press(on.getByRole('button', { name: ru('push.turnOffAria') }));

  const off = page.getByTestId('push-off');
  await expect(off).toBeVisible();
  await expect(off.getByRole('button', { name: ru('push.enable') })).toBeFocused();
  await expect(page.getByText(ru('push.offToast')).first()).toBeVisible();
  expect(await storedPushDevices(stack)).toBe(0);
  expect((await pushRecord(page)).isSubscribed).toBe(false);
  await expectAccessible(page, 'Settings, Notifications turned off');
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
