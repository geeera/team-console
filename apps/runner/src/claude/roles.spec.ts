import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TEAM_CONFIG_PRESET_ROLES } from '@shared/contracts';
import { LaunchRefusal } from '../jobs/refusal';
import { ROLE_MODELS, jobRoleOf, type JobRole } from './roles';

/**
 * `roles.ts` against the plugin's `reference/schedule-and-models.md` (the vendored copy in this repository): each
 * role's model is the pinned ID the reference lists that role under.
 */

const REFERENCE = resolve(
  import.meta.dirname,
  '../../../../.claude/product-team/reference/schedule-and-models.md',
);

/** `| Opus 5.5 | \`claude-opus-5-5\` | orchestrator (\`slot-*\`, …), \`pm\`, … |` → role → model id. */
function referenceModels(): Map<string, string> {
  const text = readFileSync(REFERENCE, 'utf8');
  const section = text.slice(text.indexOf('## Models'));
  const models = new Map<string, string>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const id = /^`(claude-[a-z0-9-]+)`$/.exec(cells[2] ?? '')?.[1];
    if (id === undefined) {
      continue;
    }
    const usedBy = (cells[3] ?? '').replace(/\([^)]*\)/g, '');
    for (const role of usedBy.matchAll(/`?([a-z][a-z-]*)`?/g)) {
      if (role[1] !== undefined && !models.has(role[1])) {
        models.set(role[1], id);
      }
    }
  }
  return models;
}

describe('roles.ts model table', () => {
  const reference = referenceModels();

  it.each(Object.entries(ROLE_MODELS))('%s runs on the model the reference pins (%s)', (role, model) => {
    expect(reference.get(role)).toBe(model);
  });

  it.each(Object.entries(ROLE_MODELS))(
    '%s falls back to the recommended preset’s model (%s), the view of a project with no configuration',
    (role, model) => {
      expect(TEAM_CONFIG_PRESET_ROLES.recommended[role as JobRole].model).toBe(model);
    },
  );

  it('refuses a role without a model', () => {
    expect(jobRoleOf('pm')).toBe('pm');
    expect(() => jobRoleOf('ux-designer')).toThrow(LaunchRefusal);
    expect(() => jobRoleOf('__proto__')).toThrow(LaunchRefusal);
  });
});
