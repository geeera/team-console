import type { CommentDto, DecisionDto, ItemEventDto } from '@shared/contracts';
import { historyOf, looksLikeCommand } from './item-history';
import {
  githubNumberOf,
  githubSourceUrlOf,
  isItemDto,
  itemNumberOfSegment,
  shownStatusOf,
} from './item.model';
import { itemFixture } from './item.fixture';

describe('item model', () => {
  it('accepts an item as the Worker sends it and refuses a malformed one', () => {
    expect(isItemDto(itemFixture())).toBe(true);
    expect(isItemDto({ ...itemFixture(), version: 0 })).toBe(false);
    expect(isItemDto({ ...itemFixture(), status: 'shipped' })).toBe(false);
    expect(isItemDto({ ...itemFixture(), body: undefined })).toBe(false);
  });

  it('reads a route number only as a positive integer', () => {
    expect(itemNumberOfSegment('142')).toBe(142);
    expect(itemNumberOfSegment('0')).toBeNull();
    expect(itemNumberOfSegment('TC-142')).toBeNull();
    expect(itemNumberOfSegment('1e3')).toBeNull();
    expect(itemNumberOfSegment(null)).toBeNull();
  });

  it('shows an item closed as not needed as closed, a done one as done', () => {
    expect(shownStatusOf(itemFixture({ state: 'closed', closedReason: 'not-planned' }))).toBe('closed');
    expect(shownStatusOf(itemFixture({ status: 'done', state: 'closed', closedReason: 'done' }))).toBe(
      'done',
    );
  });

  it('links an imported item to its github.com issue only, never another host', () => {
    const imported = itemFixture({
      source: 'import',
      sourceUrl: 'https://github.com/geeera/team-console/issues/7',
    });
    expect(githubSourceUrlOf(imported)).toBe('https://github.com/geeera/team-console/issues/7');
    expect(githubNumberOf(imported)).toBe(7);
    expect(githubSourceUrlOf({ ...imported, sourceUrl: 'https://evil.example/issues/7' })).toBeNull();
    expect(githubSourceUrlOf({ ...imported, sourceUrl: 'javascript:alert(1)' })).toBeNull();
    expect(githubSourceUrlOf(itemFixture({ sourceUrl: 'https://github.com/x/y/issues/7' }))).toBeNull();
  });

  it('takes the queue position the Worker computed, and refuses a malformed one (#456)', () => {
    expect(isItemDto(itemFixture({ queue: null }))).toBe(true);
    expect(isItemDto(itemFixture({ queue: { position: 1, total: 4 } }))).toBe(true);
    expect(isItemDto({ ...itemFixture(), queue: { position: 0, total: 4 } })).toBe(false);
    expect(isItemDto({ ...itemFixture(), queue: undefined })).toBe(false);
  });
});

describe('historyOf', () => {
  const owner = { kind: 'owner', name: 'owner' } as const;
  const event = (
    id: number,
    at: string,
    kind: ItemEventDto['kind'],
    before: unknown,
    after: unknown,
  ): ItemEventDto => ({
    id,
    at,
    actor: owner,
    kind,
    before,
    after,
  });

  it('merges events and comments oldest first, worded by kind', () => {
    const events = [
      event(1, '2026-11-01T10:00:00Z', 'created', null, null),
      event(2, '2026-11-01T11:00:00Z', 'status', { status: 'proposed' }, { status: 'approved' }),
      event(3, '2026-11-01T12:00:00Z', 'edited', { kind: 'bug' }, { kind: 'chore' }),
      event(4, '2026-11-01T12:30:00Z', 'edited', { title: 'a' }, { title: 'b' }),
      event(5, '2026-11-01T13:00:00Z', 'commented', null, { commentId: 1 }),
      event(6, '2026-11-01T14:00:00Z', 'decided', null, { decisionId: 9, command: 'reject' }),
    ];
    const comments: CommentDto[] = [
      {
        id: 1,
        kind: 'comment',
        author: owner,
        body: '/approve',
        createdAt: '2026-11-01T13:00:00Z',
        source: 'console',
        sourceUrl: null,
      },
    ];
    const decisions = [{ id: 9, command: 'reject', text: 'Too early' } as DecisionDto];
    expect(historyOf(events, comments, decisions).map((entry) => entry.line)).toEqual([
      { kind: 'created' },
      { kind: 'status', from: 'proposed', to: 'approved' },
      { kind: 'kind', from: 'bug', to: 'chore' },
      { kind: 'edited' },
      { kind: 'comment', text: '/approve' },
      { kind: 'decided', command: 'reject', text: 'Too early' },
    ]);
  });

  it('spots a comment that reads like a command', () => {
    expect(looksLikeCommand('/approve')).toBe(true);
    expect(looksLikeCommand('Looks good\n  /reject not yet')).toBe(true);
    expect(looksLikeCommand('a/b testing')).toBe(false);
  });
});
