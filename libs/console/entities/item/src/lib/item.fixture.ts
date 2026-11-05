import type { ItemDto } from '@shared/contracts';

/** An item as the Worker sends it, for this lib's specs. */
export function itemFixture(overrides: Partial<ItemDto> = {}): ItemDto {
  return {
    key: 'TC-7',
    number: 7,
    kind: 'bug',
    status: 'approved',
    severity: null,
    tier: 'standard',
    sprint: 3,
    title: 'Answer not saved on a slow network',
    body: 'Details',
    labels: ['status:approved', 'kind:bug'],
    flags: [],
    state: 'open',
    closedAt: null,
    closedReason: null,
    createdBy: { kind: 'job', name: 'pm' },
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    version: 2,
    source: 'console',
    sourceUrl: null,
    ...overrides,
  };
}
