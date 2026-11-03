import { listOf, secretCommandOf, whenOf } from './when';

describe('commands panel helpers', () => {
  const now = new Date(2026, 9, 1, 15, 0).getTime();

  it('says today, yesterday or the weekday', () => {
    expect(whenOf(new Date(2026, 9, 1, 13, 52).toISOString(), 'en', now)).toEqual({
      key: 'commands.when.today',
      params: { time: '13:52' },
    });
    expect(whenOf(new Date(2026, 8, 30, 23, 13).toISOString(), 'ru', now).key).toBe(
      'commands.when.yesterday',
    );
    expect(whenOf(new Date(2026, 8, 28, 4, 21).toISOString(), 'en', now)).toEqual({
      key: 'commands.when.day',
      params: { day: 'Mon', time: '04:21' },
    });
  });

  it('joins slot names the way the language does', () => {
    expect(listOf(['planning', 'development', 'QA'], 'en')).toBe('planning, development and QA');
    expect(listOf(['планирование', 'проверка (QA)'], 'ru')).toBe('планирование и проверка (QA)');
  });

  it('builds the secret command for the Worker config of this checkout, never with a value', () => {
    expect(secretCommandOf('SLOT_TOKEN_STORIFY_DEV', 'stage')).toBe(
      'npx wrangler secret put SLOT_TOKEN_STORIFY_DEV --env stage --config apps/api/wrangler.jsonc',
    );
    expect(secretCommandOf('SLOT_ROUTINE_STORIFY_QA', 'local')).toContain('--env production');
  });
});
