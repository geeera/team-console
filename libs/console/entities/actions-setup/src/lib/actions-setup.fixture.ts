import {
  ACTIONS_SETUP_ITEMS,
  blockingItemsOf,
  type ActionsSetupDto,
  type ActionsSetupItemDto,
  type ActionsSetupItemId,
} from '@shared/contracts';

/**
 * A readiness answer as `GET …/actions-setup` gives it, for specs and stories across the Actions setup slices: every
 * item `ok` unless `items` says otherwise, `ready` recomputed so it stays inside the contract.
 */
export function actionsSetupFixture(
  overrides: {
    readonly dispatch?: ActionsSetupDto['dispatch'];
    readonly accessSource?: ActionsSetupDto['accessSource'];
    readonly items?: Partial<Record<ActionsSetupItemId, Omit<ActionsSetupItemDto, 'id'>>>;
  } = {},
): ActionsSetupDto {
  const items = ACTIONS_SETUP_ITEMS.map(
    (id): ActionsSetupItemDto => ({ id, ...(overrides.items?.[id] ?? { status: 'ok' }) }),
  );
  return {
    dispatch: overrides.dispatch ?? 'pull',
    accessSource: overrides.accessSource ?? 'api_key',
    ready: blockingItemsOf(items).length === 0,
    checkedAt: '2026-11-21T12:02:00.000Z',
    items,
  };
}
