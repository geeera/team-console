import type { Page } from '@playwright/test';
import { contextTimeZone, dayFromToday, instantInZone } from './support/dates';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { pushAlreadyOn } from './support/push';
import { apiClient, seed } from './support/stack';

/**
 * Snooze notifications (#221, #249). Without a push subscription Snooze is off with "Push is off on this device" and a
 * Settings link. With push on (emulated, `support/push.ts`) the dialog stores the chosen snooze, which shows as the
 * struck bell with words in the panel (and the sidebar on a wide screen); Turn back on is one tap.
 */

const SNOOZE = '/api/v1/projects/team-console/notifications/snooze';
const isWide = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 900;

async function openPanel(page: Page): Promise<void> {
  await page.goto('/p/team-console/questions');
  await page.getByTestId('commands-open').click();
  await expect(page.getByTestId('notify-group')).toBeVisible();
}

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('push off on this device: Snooze is off, says why and links to Settings', async ({ page }) => {
  await openPanel(page);
  const group = page.getByTestId('notify-group');
  await expect(group.getByRole('heading', { name: ru('commands.group.notify') })).toBeVisible();
  const button = group.getByTestId('snooze-command');
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(group.getByTestId('snooze-why')).toHaveText(ru('commands.snooze.nopush'));
  await expect(group.getByRole('link', { name: ru('commands.snooze.nopushFix') })).toHaveAttribute(
    'href',
    '/settings',
  );
  await expect(group).not.toContainText(/дайджест/i);
  await expectAccessible(page, 'Commands panel, Notifications (push off)');
});

test('a snoozed project shows the struck bell with words, and one tap turns it back on', async ({
  page,
  stack,
}) => {
  const api = await apiClient(stack);
  try {
    const stored = await api.put(SNOOZE, { data: { until: null, allowsUrgent: true } });
    expect(stored.status()).toBe(200);
  } finally {
    await api.dispose();
  }

  await openPanel(page);
  if (isWide(page)) {
    await expect(page.getByTestId('switcher-snoozed')).toHaveText(ru('shell.snoozed'));
  }
  const line = page.getByTestId('snooze-line');
  await expect(line).toHaveText(`${ru('commands.snooze.forever')}. ${ru('commands.snooze.urgent')}`);
  await expectAccessible(page, 'Commands panel, Notifications (snoozed)');

  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(SNOOZE)) {
      sent.push(request.method());
    }
  });
  await page.getByTestId('snooze-command').click();
  // The project's display name comes from the registry; the rest of the sentence is fixed copy.
  const [, after = ''] = ru('commands.snooze.result.back', { name: '\u0000' }).split('\u0000');
  await expect(page.locator('.cp-result')).toContainText(after);
  expect(sent).toEqual(['DELETE']);
  await expect(line).toHaveCount(0);
  await expect(page.getByTestId('switcher-snoozed')).toHaveCount(0);
});

test('with push on, «До утра» keeping urgent ones stores the next 09:00 in Kyiv and shows it', async ({
  page,
  context,
  stack,
}, testInfo) => {
  await pushAlreadyOn(stack, context);
  // Late evening tomorrow on a fixed clock: "until morning" is the 09:00 after it, still ahead of the api's real clock.
  const timeZone = contextTimeZone(testInfo);
  const evening = instantInZone(dayFromToday(timeZone, 1), '21:30', timeZone);
  const morning = instantInZone(dayFromToday(timeZone, 2), '09:00', timeZone);
  await page.clock.setFixedTime(evening);

  await openPanel(page);
  const group = page.getByTestId('notify-group');
  const button = group.getByTestId('snooze-command');
  await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  await expect(group.getByTestId('snooze-why')).toHaveCount(0);

  const bodies: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === SNOOZE) {
      bodies.push(request.postDataJSON());
    }
  });
  const dialog = page.getByRole('dialog', {
    name: ru('commands.snooze.dialog.title', { name: 'team-console' }),
  });
  const untilMorning = dialog.getByRole('radio', { name: ru('commands.snooze.dialog.morning') });

  // Closed without choosing: nothing is stored and the keyboard is back on Snooze.
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(untilMorning).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button, 'focus returns to the button that opened the dialog').toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(untilMorning).toBeChecked();
  await expect(untilMorning).toBeFocused();
  const urgent = dialog.getByRole('checkbox', { name: ru('commands.snooze.dialog.urgent') });
  await expect(urgent).toBeChecked();
  await expectAccessible(page, 'the snooze dialog');

  await dialog.getByRole('button', { name: ru('commands.snooze.dialog.ok') }).click();

  await expect(dialog).toBeHidden();
  expect(bodies, 'one PUT, from the confirmed dialog only').toEqual([
    { until: morning.toISOString(), allowsUrgent: true },
  ]);
  const tomorrow = ru('commands.snooze.when.tomorrow', { time: '09:00' });
  await expect(group.getByTestId('snooze-line')).toHaveText(
    `${ru('commands.snooze.until', { until: tomorrow })}. ${ru('commands.snooze.urgent')}`,
  );
  const [, resultAfter = ''] = ru('commands.snooze.result.done', { name: '\u0000', until: tomorrow }).split(
    '\u0000',
  );
  const result = page.locator('.cp-result');
  await expect(result).toContainText(resultAfter);
  // After a stored snooze the result note takes focus, as after any command, so the outcome is read next.
  await expect(result).toBeFocused();
  if (isWide(page)) {
    await expect(page.getByTestId('switcher-snoozed')).toHaveText(ru('shell.snoozed'));
  }
  await expect(button).toContainText(ru('commands.snooze.back'));
  await expectAccessible(page, 'Commands panel, Notifications (snoozed until morning)');
});
