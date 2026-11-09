import type { AskDto, ItemDto } from '@shared/contracts';
import { decisionItemOf } from './task-decision';

const PROJECT = { slug: 'team-console', name: 'team-console' };
const ITEM = {
  key: 'TC-345',
  number: 345,
  kind: 'question',
  status: 'proposed',
  labels: ['status:proposed', 'kind:question', 'owner:scope'],
  state: 'open',
  title: 'Paper sound',
  body: '',
  createdBy: { kind: 'job', name: 'pm' },
} as unknown as ItemDto;
const ASK: AskDto = {
  id: 17,
  category: 'scope',
  ask: 'Take it?',
  commands: ['approve', 'reject'],
  recommended: 'approve',
  createdAt: 'x',
  source: 'console',
  state: 'open',
  answeredByDecisionId: null,
  withdrawnAt: null,
};

describe('decisionItemOf', () => {
  it('names the open console ask, with its commands and recommendation', () => {
    expect(decisionItemOf(PROJECT, ITEM, [ASK])).toMatchObject({
      section: 'question',
      key: 'TC-345',
      askId: 17,
      ask: 'Take it?',
      allowedCommands: ['approve', 'reject'],
      recommendation: 'approve',
      authorTrusted: true,
    });
  });

  it('never names an imported or answered ask, and is null when nothing waits', () => {
    expect(decisionItemOf(PROJECT, ITEM, [{ ...ASK, source: 'import' }])?.askId).toBeNull();
    expect(decisionItemOf(PROJECT, ITEM, [{ ...ASK, state: 'answered' }])?.askId).toBeNull();
    expect(
      decisionItemOf(
        PROJECT,
        { ...ITEM, labels: ['status:approved', 'kind:feature'], kind: 'feature', status: 'approved' },
        [],
      ),
    ).toBeNull();
    expect(decisionItemOf(PROJECT, { ...ITEM, state: 'closed' }, [ASK])).toBeNull();
  });
});
