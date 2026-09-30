export type OwnerLanguage = 'ru' | 'en';

// The product brief's default: the owner writes Russian unless the project says otherwise.
const DEFAULT_LANGUAGE: OwnerLanguage = 'ru';

function withoutComment(line: string): string {
  // A `#` starts a comment at the line start or after whitespace; the values read here never contain one.
  return line.replace(/(^|\s)#.*$/, '').trimEnd();
}

function unquoted(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, '$2');
}

function languageOf(value: string): OwnerLanguage {
  return unquoted(value).toLowerCase() === 'en' ? 'en' : DEFAULT_LANGUAGE;
}

/**
 * `owner.language` of a `.product-team/project.yml` (the plugin's stack contract). The file is flat YAML with
 * one-level maps, so a line reader is enough and no YAML dependency enters the Worker; anything it cannot read
 * falls back to `ru`.
 */
export function ownerLanguageOf(text: string): OwnerLanguage {
  let inOwner = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = withoutComment(raw);
    if (line.trim() === '') {
      continue;
    }
    const isTopLevel = !/^\s/.test(line);
    if (isTopLevel) {
      const flow = /^owner:\s*\{(.*)\}\s*$/.exec(line);
      const flowLanguage =
        flow?.[1] === undefined ? undefined : /(?:^|,)\s*language:\s*([^,]+)/.exec(flow[1]);
      if (flowLanguage?.[1] !== undefined) {
        return languageOf(flowLanguage[1]);
      }
      inOwner = /^owner:\s*$/.test(line);
      continue;
    }
    const language = inOwner ? /^\s+language:\s*(.+)$/.exec(line) : null;
    if (language?.[1] !== undefined) {
      return languageOf(language[1]);
    }
  }
  return DEFAULT_LANGUAGE;
}
