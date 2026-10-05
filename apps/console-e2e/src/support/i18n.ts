import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from '../stack/local-stack';

type Copy = (key: string, params?: Readonly<Record<string, string | number>>) => string;

function catalogue(lang: 'ru' | 'en'): Copy {
  const root: unknown = JSON.parse(
    readFileSync(join(WORKSPACE_ROOT, `libs/console/shared/i18n/src/lib/locales/${lang}.json`), 'utf8'),
  );
  return (key, params = {}) => {
    let node: unknown = root;
    for (const part of key.split('.')) {
      node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined;
    }
    if (typeof node !== 'string') {
      throw new Error(`no ${lang} copy for ${key}`);
    }
    return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
      const value = params[name];
      if (value === undefined) {
        throw new Error(`${lang} copy ${key} needs {{${name}}}`);
      }
      return String(value);
    });
  };
}

/**
 * The Russian copy for `key`, with Transloco's `{{param}}` placeholders filled. Throws on an unknown key. The suite
 * runs with a ru-RU browser locale, so a first launch starts in Russian (the reference copy, ADR 0002); specs find
 * controls by the same strings a user reads.
 */
export const ru: Copy = catalogue('ru');

/** The English copy for `key`: for the language specs (#4). */
export const en: Copy = catalogue('en');
