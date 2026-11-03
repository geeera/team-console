import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';

/**
 * Snooze notifications (#221). A test browser holds no push subscription, so Snooze is off with "Push is off on this
 * device" and a Settings link (the dialog itself is covered by the feature's spec). A snooze stored through the API
 * shows as the struck bell with words in the panel (and the sidebar on a wide screen), and Turn back on is one tap.
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
