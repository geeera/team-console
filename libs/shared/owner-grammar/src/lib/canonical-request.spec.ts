import type { OwnerRequest } from '@shared/contracts';
import { canonicalRequest, requestOfCanonical } from './owner-request';

// #434: `item_requests.payload` is the canonical bytes; reading them back accepts exactly those.

describe('requestOfCanonical', () => {
  const requests: OwnerRequest[] = [
    { kind: 'sprint', target: 'current' },
    { kind: 'sprint', target: 'next' },
    { kind: 'sprint', target: 'backlog' },
    { kind: 'priority', direction: 'up' },
    { kind: 'priority', direction: 'down' },
  ];

  it.each(requests)('reads back the canonical bytes of %j', (request) => {
    expect(requestOfCanonical(canonicalRequest(request))).toEqual(request);
  });

  it.each([
    '{"kind":"sprint","target":"next"}',
    '{"kind":"sprint","target":"next","v":2}',
    '{"target":"next","kind":"sprint","v":1}',
    '{"kind": "sprint","target":"next","v":1}',
    '{"kind":"sprint","target":"later","v":1}',
    '{"kind":"sprint","target":"next","v":1,"x":1}',
    '{"direction":"up","kind":"sprint","v":1}',
    '[1]',
    'not json',
  ])('refuses %s', (raw) => {
    expect(requestOfCanonical(raw)).toBeNull();
  });
});
