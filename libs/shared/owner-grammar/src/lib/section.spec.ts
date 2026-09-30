import { ANSWERS, SECTION_ORDER, askOf, kindOf, sectionOf, sectionRank } from './section';

// Expected values were produced with the plugin's Python (`ptlib.inbox.classify`, `ptlib.owner.ask_of`); the
// golden tests in @worker/read-models cover the same functions over whole repositories.

describe('sectionOf (inbox.classify)', () => {
  it.each([
    [['team:demo', 'kind:question', 'needs:owner'], 'question', 'release'],
    [['design:awaiting-approval', 'kind:question'], 'question', 'design'],
    [['needs:owner', 'kind:chore'], 'chore', 'owner'],
    [['needs:owner', 'kind:question'], 'question', 'question'],
    [['needs:owner'], null, 'owner'],
    [['kind:question'], 'question', 'question'],
    [['needs:local', 'kind:chore'], 'chore', 'local'],
    [['needs:local', 'needs:owner', 'kind:chore'], 'chore', 'owner'],
    [['status:approved', 'kind:feature'], 'feature', null],
    [['team:inbox'], null, null],
    [['design:approved', 'needs-design'], 'feature', null],
  ] as const)('%j (kind %s) → %s', (labels, kind, section) => {
    expect(sectionOf(labels, kind)).toBe(section);
  });
});

describe('kindOf', () => {
  it('takes the first kind:* label, as slim() does', () => {
    expect(kindOf(['status:blocked', 'kind:question', 'kind:chore'])).toBe('question');
    expect(kindOf(['needs:owner'])).toBeNull();
  });
});

describe('askOf (owner.ask_of)', () => {
  it.each([
    [
      '**Your answer:** /approve to ship (recommended) · /reject why\n<!-- pt-ask -->\n\nbody',
      '/approve to ship (recommended) · /reject why',
    ],
    [
      '**Твой ответ:** Напиши «сделал», когда заведёшь аккаунты\n',
      'Напиши «сделал», когда заведёшь аккаунты',
    ],
    ['**Ваш ответ:**   /go   ', '/go'],
    ['intro\n**Your answer:** /approve later line', '/approve later line'],
    ['intro **Your answer:** /approve mid-line', null],
    ['**Your answer:**\n/approve on the next line', '/approve on the next line'],
    ['**Your answer:** /approve\r\nnext', '/approve'],
    ['**Your answer:** /approve still the same line', '/approve still the same line'],
    ['**Your answer:**   ', ''],
    ['**Your Answer:** /approve', null],
    ['', null],
  ])('%j → %j', (body, ask) => {
    expect(askOf(body)).toBe(ask);
  });

  it('reads nothing from a missing body', () => {
    expect(askOf(null)).toBeNull();
    expect(askOf(undefined)).toBeNull();
  });
});

describe('the answer table (brief.ANSWERS)', () => {
  it('offers approve/reject on questions and designs, go/no-go/override on releases, done on action items', () => {
    expect(ANSWERS).toEqual({
      question: ['approve', 'reject'],
      design: ['approve', 'reject'],
      release: ['go', 'no-go', 'override'],
      owner: ['done'],
      local: ['done'],
    });
  });

  it('ranks sections in inbox order, unknown ones last', () => {
    expect(SECTION_ORDER.map(sectionRank)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(sectionRank('fyi')).toBe(99);
  });
});
