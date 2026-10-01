import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from '../stack/local-stack';

// The app starts in Russian (the reference copy, ADR 0002); specs find controls by the same strings a user reads.
const RU: unknown = JSON.parse(
  readFileSync(join(WORKSPACE_ROOT, 'libs/console/shared/i18n/src/lib/locales/ru.json'), 'utf8'),
);

/** The Russian copy for `key`, with Transloco's `{{param}}` placeholders filled. Throws on an unknown key. */
export function ru(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  let node: unknown = RU;
  for (const part of key.split('.')) {
    node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined;
  }
  if (typeof node !== 'string') {
    throw new Error(`no ru copy for ${key}`);
  }
  return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`ru copy ${key} needs {{${name}}}`);
    }
    return String(value);
  });
}
