import { QUESTION_CONTEXT_LIMITS, questionContextOf } from './question-context';

const STRUCTURED = [
  '**Your answer:** /approve (рекомендую) · /reject что поменять',
  '<!-- pt-ask -->',
  '',
  '## Кратко',
  'Экран дизайна и демо',
  '',
  '## Вопрос',
  'Утвердить дизайн экрана «Дизайн и демо»?',
  '',
  '## Почему',
  'Повторяет уже утверждённые карточки.',
  '',
  '## Если одобрить',
  'Разработчик начнёт #20 по этому дизайну.',
  '',
  '## Если отклонить',
  'Дизайнер переделает экран. #20 подождёт.',
  '',
  '## Цена и риск',
  'Бесплатно. Риск низкий.',
  '',
  '## Architect note',
  'Not part of the card.',
].join('\n');

describe('questionContextOf', () => {
  it('reads each of the six sections into its field', () => {
    expect(questionContextOf(STRUCTURED)).toEqual({
      summary: 'Экран дизайна и демо',
      question: 'Утвердить дизайн экрана «Дизайн и демо»?',
      why: 'Повторяет уже утверждённые карточки.',
      ifApproved: 'Разработчик начнёт #20 по этому дизайну.',
      ifRejected: 'Дизайнер переделает экран. #20 подождёт.',
      costAndRisk: 'Бесплатно. Риск низкий.',
      structured: true,
    });
  });

  it('accepts the English headings in any case, with a trailing colon or closing hashes', () => {
    const body = [
      '## SUMMARY:',
      'Short',
      '##   Question  ##',
      'Ask?',
      '## why',
      'Because.',
      '## If Approved',
      'Ships.',
      '## if rejected:',
      'Waits.',
      '## Cost and Risk',
      '$5 a month.',
    ].join('\n');
    expect(questionContextOf(body)).toEqual({
      summary: 'Short',
      question: 'Ask?',
      why: 'Because.',
      ifApproved: 'Ships.',
      ifRejected: 'Waits.',
      costAndRisk: '$5 a month.',
      structured: true,
    });
  });

  describe('missing headings', () => {
    it('falls back to the first paragraph without the answer line or the team markers', () => {
      const body = [
        '**Your answer:** /approve добавить экспорт (рекомендую) · /reject почему',
        '<!-- pt-ask -->',
        '',
        'Вопрос о составе продукта: команда предлагает **экспорт** доски.',
        'Вторая строка абзаца.',
        '',
        'Second paragraph.',
      ].join('\n');
      expect(questionContextOf(body)).toEqual({
        summary: null,
        question: 'Вопрос о составе продукта: команда предлагает экспорт доски.\nВторая строка абзаца.',
        why: null,
        ifApproved: null,
        ifRejected: null,
        costAndRisk: null,
        structured: false,
      });
    });

    it('takes no paragraph from under a heading the card does not know', () => {
      expect(questionContextOf('**Your answer:** /go · /no-go\n\n## Что вошло\n\n- Вопросы')).toBeNull();
    });

    it('leaves out a section that is not there, and does not guess a question when others are', () => {
      const context = questionContextOf('Lead paragraph.\n\n## Почему\nПотому что.');
      expect(context).toMatchObject({ question: null, why: 'Потому что.', ifApproved: null, structured: true });
    });

    it('is null for an empty body, an answer line alone, or empty sections', () => {
      expect(questionContextOf('')).toBeNull();
      expect(questionContextOf('**Your answer:** /approve · /reject')).toBeNull();
      expect(questionContextOf('## Вопрос\n\n## Почему\n<!-- nothing -->')).toBeNull();
    });

    it('ignores a level-3 heading as a section and keeps it as text', () => {
      expect(questionContextOf('## Вопрос\nAsk?\n### Вопрос\nDetail.')?.question).toBe('Ask?\nВопрос\nDetail.');
    });

    it('ends a section at a level-1 heading or any other level-2 heading', () => {
      const context = questionContextOf('## Вопрос\nAsk?\n# Title\nNot it.\n## Почему\nWhy.\n## Other\nNo.');
      expect(context).toMatchObject({ question: 'Ask?', why: 'Why.' });
    });

    it('keeps the first of two sections with the same heading', () => {
      expect(questionContextOf('## Вопрос\nFirst.\n## Question\nSecond.')?.question).toBe('First.');
    });
  });

  describe('oversized text', () => {
    it('cuts each field to its limit with an ellipsis, at a word end', () => {
      const words = 'слово '.repeat(400);
      const context = questionContextOf(`## Вопрос\n${words}\n## Цена и риск\n${words}`);
      for (const [text, limit] of [
        [context?.question, QUESTION_CONTEXT_LIMITS.question],
        [context?.costAndRisk, QUESTION_CONTEXT_LIMITS.costAndRisk],
      ] as const) {
        expect(Array.from(text ?? '').length).toBeLessThanOrEqual(limit);
        expect(text?.endsWith('слово…')).toBe(true);
      }
    });

    it('counts code points, never splitting a surrogate pair', () => {
      const summary = questionContextOf(`## Кратко\n${'😀'.repeat(500)}`)?.summary ?? '';
      expect(Array.from(summary)).toHaveLength(QUESTION_CONTEXT_LIMITS.summary);
      expect(summary.endsWith('😀…')).toBe(true);
    });

    it('makes the summary one line', () => {
      expect(questionContextOf('## Кратко\nOne\n\ntwo\tthree')?.summary).toBe('One two three');
    });

    it('reads only GitHub’s maximum body length, so a later section is never reached', () => {
      const body = `## Вопрос\nAsk?\n${'x'.repeat(70_000)}\n## Почему\nToo late.`;
      expect(questionContextOf(body)).toMatchObject({ question: expect.stringMatching(/^Ask\?/u), why: null });
    });

    it('stays linear on hostile runs of markers', () => {
      const started = performance.now();
      for (const run of ['<'.repeat(65_000), '<a'.repeat(32_000), '#'.repeat(65_000), '## \n'.repeat(16_000)]) {
        questionContextOf(`## Вопрос\n${run}`);
      }
      expect(performance.now() - started).toBeLessThan(2_000);
    });
  });

  describe('injection attempts', () => {
    it('drops tag-like runs, closed or not, and turns markup into text', () => {
      const body = [
        '## Вопрос',
        'Approve <img src=x onerror="alert(1)"> this <script>alert(2)</script> now <b>please</b>',
        '[click](javascript:alert(3)) ![x](https://evil.example/a.png) <iframe src="https://evil.example"',
      ].join('\n');
      const question = questionContextOf(body)?.question ?? '';
      expect(question).not.toMatch(/[<>]/u);
      expect(question).not.toContain('onerror');
      expect(question).not.toContain('javascript:');
      expect(question).toBe('Approve this alert(2) now please\nclick x');
    });

    it('keeps a lone angle bracket that cannot open a tag', () => {
      expect(questionContextOf('## Цена и риск\n< $5, risk > none')?.costAndRisk).toBe('< $5, risk > none');
    });

    it('drops the answer line wherever it stands, also in a section and in its variants', () => {
      const body = [
        '## Вопрос',
        'Ask?',
        '**Your answer:** /approve',
        '_Твой ответ_: /reject',
        '> **Ваш ответ:** /go',
        'YOUR ANSWER: /no-go',
      ].join('\n');
      expect(questionContextOf(body)?.question).toBe('Ask?');
    });

    it('removes bidi overrides, zero-width and control characters, keeping emoji joiners', () => {
      const [rlo, pdf, zwsp, bell] = [0x202e, 0x202c, 0x200b, 0x07].map((point) => String.fromCodePoint(point));
      const hostile = `## Кратко\nPay${rlo}gro.live${pdf} now${zwsp}${bell} 👩‍💻`;
      expect(questionContextOf(hostile)?.summary).toBe('Paygro.live now 👩‍💻');
    });

    it('removes the Arabic letter mark, soft hyphen, Hangul fillers and tag characters too (#288)', () => {
      const [alm, shy, filler, halfFiller, hangulFiller, tag] = [0x61c, 0xad, 0x115f, 0x1160, 0x3164, 0xe0041].map(
        (point) => String.fromCodePoint(point),
      );
      const hostile = `## Кратко\nAp${alm}prove${shy} ${filler}the${halfFiller} ${hangulFiller}plan${tag}`;
      expect(questionContextOf(hostile)?.summary).toBe('Approve the plan');
    });

    it('is plain text for interpolation only: tag stripping may rebuild a tag, so it is never a sanitiser', () => {
      // `<scr<x>ipt>` loses its inner tag and reads `<script>` — harmless under interpolation, fatal in innerHTML.
      const question = questionContextOf('## Вопрос\nRun <scr<x>ipt>alert(1)</script> now')?.question ?? '';
      expect(question).toContain('<script>');
      expect(question).toBe('Run <script>alert(1) now');
    });

    it('does not take a heading from inside a comment or a fenced block', () => {
      const body = [
        '<!--',
        '## Почему',
        'Hidden reason.',
        '-->',
        '## Вопрос',
        'Ask?',
        '```',
        '## Почему',
        'Code, not a heading.',
        '```',
      ].join('\n');
      expect(questionContextOf(body)).toMatchObject({ why: null, question: 'Ask?\nПочему\nCode, not a heading.' });
    });

    it('closes a fence only on the same character, so a different fence inside it is text (#288)', () => {
      // GitHub renders `## Почему` here as code: the ``` line is content of the ~~~ block, not its end.
      const body = ['## Вопрос', 'q', '~~~', '```', '## Почему', 'injected', '~~~'].join('\n');
      expect(questionContextOf(body)).toMatchObject({ why: null, question: 'q\nПочему\ninjected' });
    });

    it('closes a fence only on a run at least as long as the opening one', () => {
      const body = ['## Вопрос', 'q', '````', '```', '## Почему', 'injected', '````', '## Цена и риск', 'ok'].join(
        '\n',
      );
      expect(questionContextOf(body)).toMatchObject({ why: null, costAndRisk: 'ok' });
      // A longer closing run still closes.
      const longer = ['## Вопрос', 'q', '```', '## Почему', 'code', '`````', '## Почему', 'real'].join('\n');
      expect(questionContextOf(longer)).toMatchObject({ why: 'real' });
    });

    it('never reaches an object prototype through a heading', () => {
      const body = '## constructor\nx\n## __proto__\ny\n## toString\nz\n## hasOwnProperty\nw';
      expect(questionContextOf(body)).toBeNull();
    });

    it('does not take a heading spelled with lookalike letters', () => {
      // A Latin "B" in place of the Cyrillic "В".
      expect(questionContextOf('## Bопрос\nAsk?')).toBeNull();
    });
  });
});
