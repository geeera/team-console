import { actionAskOf, askOutcomesOf, plainAskOf, plainDetailsOf } from './question-text';

const text = (value: string) => ({ kind: 'text', text: value });

describe('plainAskOf', () => {
  it('says the recommended first option in words, without its command, mark or the alternatives', () => {
    expect(
      plainAskOf(
        '/approve — начинаем разработку по плану к демо 16 октября (рекомендую) · /reject что поменять',
      ),
    ).toEqual(text('Начинаем разработку по плану к демо 16 октября'));
    expect(plainAskOf('/approve экран (рекомендую) · /reject что поменять')).toEqual(text('Экран'));
  });

  it('finds the recommendation when it is not the first option', () => {
    expect(plainAskOf('/reject оставить как есть · /approve — перейти на R2 (рекомендую)')).toEqual(
      text('Перейти на R2'),
    );
  });

  it('reads an English ask, with commands in backticks and the mark among other notes', () => {
    expect(
      plainAskOf('`/approve` to use Cloudflare R2 (free, recommended) · `/reject why` to keep SeaweedFS'),
    ).toEqual(text('Use Cloudflare R2 (free)'));
    expect(plainAskOf('/approve to ship (recommended) · /reject why')).toEqual(text('Ship'));
  });

  it('names a bare recommended command by the command, for the card to label', () => {
    expect(plainAskOf('/go (рекомендую) · /no-go что доделать')).toEqual({ kind: 'command', command: 'go' });
  });

  it('is null without a recognised recommendation, so "the team recommends" never shows the leftover options or an owner instruction as advice (#210)', () => {
    expect(plainAskOf('/approve онбординг · /reject что поменять')).toBeNull();
    expect(plainAskOf('Напиши «сделал», когда переключишь источник GitHub Pages')).toBeNull();
    expect(
      plainAskOf('Напиши «сделал», когда заведёшь аккаунты по чеклисту из #7 · /reject причина, если что-то не подходит'),
    ).toBeNull();
  });

  it('is null when nothing readable is left, so the card never shows an empty block', () => {
    expect(plainAskOf(null)).toBeNull();
    expect(plainAskOf('')).toBeNull();
    expect(plainAskOf('/approve · /reject')).toBeNull();
    expect(plainAskOf('  **  ')).toBeNull();
  });

  it('keeps HTML in the ask as inert text and leaves URLs and paths alone', () => {
    expect(plainAskOf('/approve <img src=x onerror=alert(document.cookie)> (рекомендую) · /reject why')).toEqual(
      text('<img src=x onerror=alert(document.cookie)>'),
    );
    expect(plainAskOf('/approve см. https://example.org/a/b и docs/x (рекомендую)')).toEqual(
      text('См. https://example.org/a/b и docs/x'),
    );
  });

  it('drops markdown marks from the words', () => {
    expect(plainAskOf('/approve — **начинаем** `сейчас` (рекомендую) · /reject')).toEqual(
      text('Начинаем сейчас'),
    );
  });
});

describe('actionAskOf (#291)', () => {
  it('says the plugin’s "Напиши «сделал», когда…" in the console’s own voice, with no command, "·" or reject-side prompt', () => {
    expect(actionAskOf('Напиши «сделал», когда переключишь источник GitHub Pages')).toBe(
      'Нажмите «Готово», когда переключишь источник GitHub Pages',
    );
    expect(
      actionAskOf(
        'Напиши «сделал», когда заведёшь аккаунты по чеклисту из #7 · /reject причина, если что-то не подходит',
      ),
    ).toBe('Нажмите «Готово», когда заведёшь аккаунты по чеклисту из #7');
  });

  it('keeps any other wording as it is', () => {
    expect(actionAskOf('Переключи источник GitHub Pages')).toBe('Переключи источник GitHub Pages');
  });

  it('is null when nothing readable is left', () => {
    expect(actionAskOf(null)).toBeNull();
    expect(actionAskOf('')).toBeNull();
    expect(actionAskOf('/done')).toBeNull();
  });
});

describe('plainDetailsOf', () => {
  it('drops the answer line, the team markers and the markup', () => {
    const body =
      '**Your answer:** /approve — начинаем (рекомендую) · /reject что поменять\n<!-- pt-ask -->\n\n' +
      'Сегодня **решено**: инфраструктуру __не трогаем__.\n<!-- pt-meta: x -->\n- `dev` остаётся';
    expect(plainDetailsOf(body)).toBe('Сегодня решено: инфраструктуру не трогаем.\n\n• dev остаётся');
  });

  it('is empty when the body holds nothing but the answer line and markers', () => {
    expect(plainDetailsOf('**Ваш ответ:** /go\n<!-- pt-ask -->\n')).toBe('');
  });
});

describe('askOutcomesOf (#276 fallback)', () => {
  it('reads each side’s option without its command or mark', () => {
    expect(askOutcomesOf('`/approve` to enable branch protection (recommended) · `/reject why` to keep it')).toEqual({
      ifApproved: 'Enable branch protection',
      ifRejected: 'Why to keep it',
    });
  });

  it('drops a side that is only the plugin’s placeholder prompt, so it never reads as a bare question (#291)', () => {
    expect(askOutcomesOf('/approve добавить экспорт в CSV (рекомендую) · /reject почему')).toEqual({
      ifApproved: 'Добавить экспорт в CSV',
      ifRejected: null,
    });
    expect(askOutcomesOf('/approve макет настроек (рекомендую) · /reject что поменять')).toEqual({
      ifApproved: 'Макет настроек',
      ifRejected: null,
    });
  });

  it('maps go and no-go to the same sides', () => {
    expect(askOutcomesOf('/go (рекомендую) · /no-go что доделать')).toEqual({
      ifApproved: null,
      ifRejected: 'Что доделать',
    });
  });

  it('gives nothing for an instruction, a missing line, or options with no words', () => {
    expect(askOutcomesOf('Напишите «сделал»')).toEqual({ ifApproved: null, ifRejected: null });
    expect(askOutcomesOf(null)).toEqual({ ifApproved: null, ifRejected: null });
    expect(askOutcomesOf('/approve · /reject')).toEqual({ ifApproved: null, ifRejected: null });
  });

  it('keeps hostile text as inert words', () => {
    expect(askOutcomesOf('/approve <img src=x onerror=alert(1)> · /reject why').ifApproved).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });
});
