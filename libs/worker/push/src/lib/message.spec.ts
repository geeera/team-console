import {
  InvalidPushTargetError,
  PUSH_TEXT_MAX_LENGTH,
  cleanPushText,
  questionNotification,
  questionPushUrl,
  testNotification,
} from './message';

describe('questionPushUrl (threat model on #11, row 6)', () => {
  it('builds the relative path to the item in its project space', () => {
    expect(questionPushUrl('storify', 42)).toBe('/p/storify/questions#42');
  });

  it.each(['a/b', 'evil.example:443', '//evil', 'https:', 'Storify', '', '-x', 'x-', '..', 'a b', 'needs-you/..'])(
    'refuses the slug %j',
    (slug) => {
      expect(() => questionPushUrl(slug, 1)).toThrow(InvalidPushTargetError);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuses the number %s',
    (number) => {
      expect(() => questionPushUrl('storify', number)).toThrow(InvalidPushTargetError);
    },
  );

  it('never yields anything but a same-origin path with a digits-only fragment (property)', () => {
    const alphabet = 'abz09-/:.\\@?#%A ';
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let run = 0; run < 2000; run += 1) {
      const slug = Array.from({ length: 1 + Math.floor(random() * 12) }, () =>
        alphabet.charAt(Math.floor(random() * alphabet.length)),
      ).join('');
      const number = Math.floor(random() * 2000) - 100 + (random() < 0.1 ? 0.5 : 0);
      let url: string;
      try {
        url = questionPushUrl(slug, number);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(InvalidPushTargetError);
        continue;
      }
      expect(url).toMatch(/^\/p\/[a-z0-9-]+\/questions#[0-9]+$/);
      expect(url.startsWith('//')).toBe(false);
      expect(new URL(url, 'https://console.example').origin).toBe('https://console.example');
    }
  });
});

describe('cleanPushText', () => {
  it('turns control characters into single spaces and drops bidi overrides', () => {
    expect(cleanPushText('a\u0000b\nc\r\n\td\u007fe\u0085f')).toBe('a b c d e f');
    expect(cleanPushText('safe ‮gnp.exe‬ name⁦x⁩')).toBe('safe gnp.exe namex');
  });

  it('keeps text up to 120 characters as it is', () => {
    const text = 'я'.repeat(PUSH_TEXT_MAX_LENGTH);
    expect(cleanPushText(text)).toBe(text);
  });

  it('cuts longer text to 120 characters, the ellipsis included', () => {
    const cut = cleanPushText(`${'x'.repeat(200)}`);
    expect([...cut]).toHaveLength(PUSH_TEXT_MAX_LENGTH);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('counts characters, not UTF-16 units, and never splits a surrogate pair', () => {
    const cut = cleanPushText('🍉'.repeat(130));
    expect([...cut]).toHaveLength(PUSH_TEXT_MAX_LENGTH);
    expect(cut).toBe(`${'🍉'.repeat(PUSH_TEXT_MAX_LENGTH - 1)}…`);
  });
});

describe('notification payloads (ngsw format)', () => {
  it('builds a question notification in Russian with «вы», opening the item', () => {
    expect(
      questionNotification({
        language: 'ru',
        slug: 'storify',
        projectName: 'Storify',
        number: 42,
        issueTitle: 'Выбрать провайдера оплаты',
      }),
    ).toMatchInlineSnapshot(`
      {
        "notification": {
          "body": "#42 Выбрать провайдера оплаты",
          "data": {
            "onActionClick": {
              "default": {
                "operation": "navigateLastFocusedOrOpen",
                "url": "/p/storify/questions#42",
              },
            },
          },
          "icon": "/icons/icon-192.png",
          "lang": "ru",
          "tag": "p/storify/questions/42",
          "title": "Storify · нужен ваш ответ",
        },
      }
    `);
  });

  it('cleans and cuts an untrusted issue title and project name', () => {
    const { notification } = questionNotification({
      language: 'en',
      slug: 'storify',
      projectName: 'Story‮fy\n',
      number: 7,
      issueTitle: `Click\nhttps://evil.example ${'z'.repeat(300)}`,
    });
    expect(notification.title).toBe('Storyfy · your answer is needed');
    expect([...notification.body]).toHaveLength(PUSH_TEXT_MAX_LENGTH);
    expect(notification.body).not.toContain('\n');
    expect(notification.data.onActionClick.default.url).toBe('/p/storify/questions#7');
  });

  it('refuses to build a notification for an invalid target', () => {
    expect(() =>
      questionNotification({ language: 'ru', slug: 'a/b', projectName: 'x', number: 1, issueTitle: 'x' }),
    ).toThrow(InvalidPushTargetError);
  });

  it('builds the test notification, opening Needs you', () => {
    expect(testNotification('ru').notification).toMatchObject({
      title: 'Тестовое уведомление',
      body: 'Работает. Нажмите, чтобы открыть «Ждут вас».',
      tag: 'test',
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: '/needs-you' } } },
    });
    expect(testNotification('en').notification.title).toBe('Test notification');
  });
});
