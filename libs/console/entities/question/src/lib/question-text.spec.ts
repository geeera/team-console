import { plainAskOf, plainDetailsOf } from './question-text';

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

  it('without a recommendation, shows the ask without command words', () => {
    expect(plainAskOf('/approve онбординг · /reject что поменять')).toEqual(text('Онбординг · что поменять'));
    expect(plainAskOf('Напиши «сделал», когда переключишь источник GitHub Pages')).toEqual(
      text('Напиши «сделал», когда переключишь источник GitHub Pages'),
    );
  });

  it('is null when nothing readable is left, so the card never shows an empty block', () => {
    expect(plainAskOf(null)).toBeNull();
    expect(plainAskOf('')).toBeNull();
    expect(plainAskOf('/approve · /reject')).toBeNull();
    expect(plainAskOf('  **  ')).toBeNull();
  });

  it('keeps HTML in the ask as inert text and leaves URLs and paths alone', () => {
    expect(plainAskOf('/approve <img src=x onerror=alert(document.cookie)> · /reject why')).toEqual(
      text('<img src=x onerror=alert(document.cookie)> · why'),
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
