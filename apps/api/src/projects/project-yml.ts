import { DEFAULT_FREEZE_DAYS, MAX_FREEZE_DAYS } from '@shared/contracts';

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

function escaped(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The raw value of `block.key` in a `.product-team/project.yml` (the plugin's stack contract), block form or flow
 * form; `undefined` when it is not there. The file is flat YAML with one-level maps, so a line reader is enough and
 * no YAML dependency enters the Worker.
 */
function blockValueOf(text: string, block: string, key: string): string | undefined {
  const flowPattern = new RegExp(`^${escaped(block)}:\\s*\\{(.*)\\}\\s*$`);
  const blockPattern = new RegExp(`^${escaped(block)}:\\s*$`);
  const flowKey = new RegExp(`(?:^|,)\\s*${escaped(key)}:\\s*([^,]+)`);
  const blockKey = new RegExp(`^\\s+${escaped(key)}:\\s*(.+)$`);
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = withoutComment(raw);
    if (line.trim() === '') {
      continue;
    }
    const isTopLevel = !/^\s/.test(line);
    if (isTopLevel) {
      const flow = flowPattern.exec(line);
      const flowValue = flow?.[1] === undefined ? undefined : flowKey.exec(flow[1]);
      if (flowValue?.[1] !== undefined) {
        return flowValue[1];
      }
      inBlock = blockPattern.test(line);
      continue;
    }
    const value = inBlock ? blockKey.exec(line) : null;
    if (value?.[1] !== undefined) {
      return value[1];
    }
  }
  return undefined;
}

/** `owner.language`; anything it cannot read falls back to `ru`. */
export function ownerLanguageOf(text: string): OwnerLanguage {
  const value = blockValueOf(text, 'owner', 'language');
  return value !== undefined && unquoted(value).toLowerCase() === 'en' ? 'en' : DEFAULT_LANGUAGE;
}

/**
 * `sprint.freeze_days` (the plugin's `calendar.compute`): a whole number of days from 0 to `MAX_FREEZE_DAYS`;
 * anything else — missing, quoted nonsense, negative, fractional — is the plugin's default of 2.
 */
export function freezeDaysOf(text: string): number {
  const value = blockValueOf(text, 'sprint', 'freeze_days');
  const plain = value === undefined ? '' : unquoted(value);
  if (!/^[0-9]{1,2}$/.test(plain)) {
    return DEFAULT_FREEZE_DAYS;
  }
  const days = Number(plain);
  return days <= MAX_FREEZE_DAYS ? days : DEFAULT_FREEZE_DAYS;
}
