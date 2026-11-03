import { localTimeOf } from '@console/shared/i18n';

const LOCALES: Readonly<Record<string, string>> = { ru: 'ru-RU', en: 'en-GB' };
const DAY_MS = 24 * 60 * 60 * 1000;

/** `today 13:52`, `yesterday 23:13`, `Mon 04:21` — the key and params of `commands.when.*`. */
export function whenOf(
  iso: string,
  lang: string,
  nowMs: number,
): { key: string; params: Record<string, string> } {
  const date = new Date(iso);
  const time = localTimeOf(date, lang);
  const day = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((day(date) - day(new Date(nowMs))) / DAY_MS);
  if (diff === 0) {
    return { key: 'commands.when.today', params: { time } };
  }
  if (diff === -1) {
    return { key: 'commands.when.yesterday', params: { time } };
  }
  const weekday = new Intl.DateTimeFormat(LOCALES[lang] ?? lang, { weekday: 'short' }).format(date);
  return { key: 'commands.when.day', params: { day: weekday, time } };
}

/** "planning, development and QA" in the reader's language. */
export function listOf(items: readonly string[], lang: string): string {
  return new Intl.ListFormat(LOCALES[lang] ?? lang, { type: 'conjunction' }).format(items);
}

const ENVIRONMENTS: ReadonlySet<string> = new Set(['dev', 'stage', 'production']);

/**
 * The command that saves one secret on the console's api Worker, run in the team-console checkout: wrangler asks for
 * the value at a hidden prompt, so it never sits in argv or the shell history. A local run names production, where
 * the routines are meant to live.
 */
export function secretCommandOf(name: string, environment: string): string {
  const env = ENVIRONMENTS.has(environment) ? environment : 'production';
  return `npx wrangler secret put ${name} --env ${env} --config apps/api/wrangler.jsonc`;
}
