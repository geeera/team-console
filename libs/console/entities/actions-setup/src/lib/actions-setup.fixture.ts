import {
  ACTIONS_SETUP_ITEMS,
  blockingItemsOf,
  type ActionsSetupDto,
  type ActionsSetupItemDto,
  type ActionsSetupItemId,
  type ActionsSetupVersionsDto,
} from '@shared/contracts';

const PINS = { runner: '0.2.0', node: '22.23.5', claudeCode: '2.1.325' } as const;

/**
 * A readiness answer as `GET …/actions-setup` gives it, for specs and stories across the Actions setup slices: every
 * item `ok` unless `items` says otherwise, `ready` recomputed so it stays inside the contract.
 */
export function actionsSetupFixture(
  overrides: {
    readonly dispatch?: ActionsSetupDto['dispatch'];
    readonly accessSource?: ActionsSetupDto['accessSource'];
    readonly items?: Partial<Record<ActionsSetupItemId, Omit<ActionsSetupItemDto, 'id'>>>;
    readonly defaultBranch?: string | null;
    readonly workflowPr?: ActionsSetupDto['workflowPr'];
    readonly versions?: Partial<ActionsSetupVersionsDto>;
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
    defaultBranch: overrides.defaultBranch === undefined ? 'main' : overrides.defaultBranch,
    workflowPr: overrides.workflowPr ?? 'enabled',
    versions: { expected: PINS, current: PINS, minRunner: null, runnerSupport: 'supported', ...overrides.versions },
  };
}
