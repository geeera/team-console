import {
  CAP_MODES,
  TEAM_CONFIG_SCHEMA,
  checkTeamConfig,
  type TeamConfig,
  type TeamConfigImportNote,
} from '@shared/contracts';
import { ProjectConfigError, parseProjectYmlRoot } from '@worker/read-models';

/**
 * The team-config import (ADR 0009 d.9, d.11, "Migration" 2; threat model C12 row 7): a draft built from the default
 * branch's `.product-team/project.yml` for the owner to review and save through `PUT` — never saved here.
 *
 * The file is repository content any merged PR can write, so it is untrusted: size-capped and parsed with the shared
 * safe profile (`parseProjectYmlRoot`: YAML 1.2 core schema, no custom tags, no merge keys, no alias resolved at all),
 * and only `review.*`, `caps.*`, `sprint.*` and `owner.language` are read, copied key by key into null-prototype
 * objects. Models come from the `recommended` preset, never from the file; `access`, `budget` and `cost` are never
 * imported. The 0.11 template's `never` becomes `code` with a note, the one lossy mapping.
 */

export const TEAM_CONFIG_IMPORT_PATH = '.product-team/project.yml';
export const TEAM_CONFIG_IMPORT_MAX_BYTES = 64 * 1024;

export type ImportDraftOutcome =
  | { readonly ok: true; readonly draft: TeamConfig; readonly notes: readonly TeamConfigImportNote[] }
  | { readonly ok: false; readonly field: string; readonly detail: string };

type Plain = Record<string, unknown>;

/** How deep the `model:` scan walks; project.yml is a flat file of one-level maps. */
const MODEL_SCAN_DEPTH = 6;

function isPlain(value: unknown): value is Readonly<Plain> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-copies `value` through JSON, the same round-trip `checkTeamConfig`'s final guard uses: it drops any forged
 * prototype on an array's object elements (#708), not just the array's own shallow copy.
 */
function plainCopyOf<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The own members of `value` named in `keys`, into an object with no prototype; the rest are noted as ignored. */
export function pick(value: unknown, keys: readonly string[], path: string, notes: TeamConfigImportNote[]): Plain | undefined {
  if (!isPlain(value)) {
    return undefined;
  }
  const copy = Object.create(null) as Plain;
  for (const key of Object.keys(value)) {
    if (keys.includes(key)) {
      const member = value[key];
      copy[key] = Array.isArray(member) ? plainCopyOf(member) : member;
    } else if (key !== 'model') {
      notes.push({ path: `${path}.${key}`, code: 'key-ignored' });
    }
  }
  return Object.keys(copy).length === 0 ? undefined : copy;
}

/** Every `model:` key of the file, which the import never reads (models come from `recommended`). */
function modelNotes(value: unknown, path: string, depth: number, notes: TeamConfigImportNote[]): void {
  if (!isPlain(value) || depth > MODEL_SCAN_DEPTH) {
    return;
  }
  for (const key of Object.keys(value)) {
    const at = path === '' ? key : `${path}.${key}`;
    if (key === 'model') {
      notes.push({ path: at, code: 'model-ignored' });
    } else {
      modelNotes(value[key], at, depth + 1, notes);
    }
  }
}

function gatesOf(review: unknown, notes: TeamConfigImportNote[]): Plain | undefined {
  const gates = pick(review, ['qa', 'reviewer', 'code_paths', 'max_rework_rounds'], 'review', notes);
  for (const gate of ['qa', 'reviewer'] as const) {
    if (gates?.[gate] === 'never') {
      gates[gate] = 'code';
      notes.push({ path: `review.${gate}`, code: 'never-as-code' });
    }
  }
  return gates;
}

function capsOf(caps: unknown, notes: TeamConfigImportNote[]): Plain | undefined {
  if (!isPlain(caps)) {
    return undefined;
  }
  const copy = Object.create(null) as Plain;
  for (const key of Object.keys(caps)) {
    if ((CAP_MODES as readonly string[]).includes(key)) {
      copy[key] = pick(caps[key], ['dev_tasks', 'parallel_devs'], `caps.${key}`, notes) ?? Object.create(null);
    } else {
      notes.push({ path: `caps.${key}`, code: 'key-ignored' });
    }
  }
  return Object.keys(copy).length === 0 ? undefined : copy;
}

/** A draft path back to the file's own (`gates.qa` → `review.qa`), so a refusal names what the owner must fix. */
function filePathOf(field: string): string {
  if (field === 'gates' || field.startsWith('gates.')) {
    return `review${field.slice('gates'.length)}`;
  }
  return field === 'language' ? 'owner.language' : field;
}

const member = (value: unknown, key: string): unknown => (isPlain(value) && Object.hasOwn(value, key) ? value[key] : undefined);

/** The draft of `text` (project.yml), or the path of the first value the schema refuses. */
export function teamConfigDraftOf(text: string): ImportDraftOutcome {
  let root: Readonly<Plain>;
  try {
    root = parseProjectYmlRoot(text);
  } catch (error: unknown) {
    if (error instanceof ProjectConfigError) {
      return { ok: false, field: 'project.yml', detail: `project.yml is not usable: ${error.failure}` };
    }
    throw error;
  }
  const notes: TeamConfigImportNote[] = [];
  modelNotes(root, '', 0, notes);
  const gates = gatesOf(member(root, 'review'), notes);
  const caps = capsOf(member(root, 'caps'), notes);
  const sprint = pick(member(root, 'sprint'), ['length_days', 'freeze_days'], 'sprint', notes);
  const language = member(member(root, 'owner'), 'language');
  const draft: Plain = Object.create(null) as Plain;
  draft['schema'] = TEAM_CONFIG_SCHEMA;
  draft['preset'] = 'recommended';
  if (gates !== undefined) {
    draft['gates'] = gates;
  }
  if (caps !== undefined) {
    draft['caps'] = caps;
  }
  if (sprint !== undefined) {
    draft['sprint'] = sprint;
  }
  if (language !== undefined) {
    draft['language'] = language;
  }
  // The guard copies the draft into plain JSON, so nothing of the parser's objects leaves this function.
  const check = checkTeamConfig(draft);
  if (!check.ok) {
    const field = filePathOf(check.field);
    return { ok: false, field, detail: `${field} in project.yml: ${check.detail}` };
  }
  return { ok: true, draft: check.value, notes };
}
