import { INBOX_ORDER, askOf, sectionRank } from './inbox';

// Expected values were produced with the plugin's Python (`ptlib.owner.ask_of`, `ptlib.inbox.ORDER`); the golden
// tests in @worker/read-models cover them over whole repositories.

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
    ['**Your answer:** /approve\u2028still the same line', '/approve\u2028still the same line'],
    ['**Your answer:**   ', ''],
    ['**Your answer:** /approve\ufeff', '/approve\ufeff'],
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

describe('sectionRank (inbox.ORDER)', () => {
  it('ranks sections in inbox order, unknown ones last', () => {
    expect(INBOX_ORDER.map(sectionRank)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(sectionRank('fyi')).toBe(99);
  });
});
