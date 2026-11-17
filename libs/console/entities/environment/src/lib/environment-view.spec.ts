import {
  ENVIRONMENT_MANIFEST,
  consoleRowsOf,
  projectRowsOf,
  type EnvironmentStatusDto,
} from '@shared/environment';
import {
  environmentViewOf,
  guideSourceOf,
  projectEnvironmentViewOf,
  proseSegmentsOf,
  type EnvironmentView,
} from './environment-view';
import { entryChipOf, projectEntryChipOf } from './environment-entry';

function item(name: string) {
  const found = ENVIRONMENT_MANIFEST.items.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no manifest item ${name}`);
  }
  return found;
}

/** Every console row production's Worker can see (or one project's), all set but the given ids. */
function productionStatus(missing: readonly string[], project: string | null = null): EnvironmentStatusDto {
  return {
    environment: 'production',
    items: (project === null ? consoleRowsOf('production') : projectRowsOf('production', project))
      .filter((row) => row.binding !== null)
      .map((row) => ({
        id: row.id,
        status: missing.includes(row.id) ? 'missing' : 'set',
        optional: row.item.optional === true,
      })),
  };
}

function statusById(view: EnvironmentView): Map<string, string> {
  return new Map(view.rows.map((row) => [row.row.id, row.status]));
}

describe('environmentViewOf', () => {
  it('on this console: set and missing from the Worker, the rest not visible, missing first in each group', () => {
    const view = environmentViewOf({
      environment: 'production',
      thisEnvironment: 'production',
      snapshot: productionStatus(['api/VAPID_PRIVATE_KEY', 'api/OWNER_EMAIL']),
    });

    const byId = statusById(view);
    expect(byId.get('api/VAPID_PRIVATE_KEY')).toBe('missing');
    expect(byId.get('api/TOKEN_ENCRYPTION_KEY')).toBe('set');
    expect(byId.get('hooks/VAPID_PRIVATE_KEY')).toBe('unseen');
    expect(byId.get('github-secrets/CLOUDFLARE_API_TOKEN')).toBe('unseen');
    const api = view.groups.find((group) => group.group === 'api');
    expect(api?.rows.slice(0, 2).map((row) => row.status)).toEqual(['missing', 'missing']);
    expect(view.missing).toBe(2);
    expect(view.firstMissing?.status).toBe('missing');
    // #750: the operator screen has no projects group.
    expect(view.groups.some((group) => group.group === 'projects')).toBe(false);
    expect(view.rows.some((row) => row.row.project !== null)).toBe(false);
    expect(view.unseen).toBeGreaterThan(0);
  });

  it("on another environment's tab every row is not visible here, whatever the snapshot says", () => {
    const view = environmentViewOf({
      environment: 'stage',
      thisEnvironment: 'production',
      snapshot: productionStatus(['api/VAPID_PRIVATE_KEY']),
    });
    expect(view.isThisConsole).toBe(false);
    expect(view.rows.every((row) => row.status === 'unseen')).toBe(true);
    expect(view.missing).toBe(0);
  });

  it('leaves checkable rows blank while there is no answer', () => {
    const view = environmentViewOf({
      environment: 'dev',
      thisEnvironment: 'dev',
      snapshot: null,
    });
    expect(statusById(view).get('api/OWNER_EMAIL')).toBe('unknown');
    expect(statusById(view).get('hooks/WEBHOOK_SECRET')).toBe('unseen');
  });
});

describe('entryChipOf', () => {
  it('checks, then counts what is missing, else all set', () => {
    expect(entryChipOf('idle', null)).toEqual({ kind: 'checking' });
    expect(entryChipOf('loading', null)).toEqual({ kind: 'checking' });
    expect(entryChipOf('ready', productionStatus(['api/OWNER_EMAIL', 'api/VAPID_PRIVATE_KEY']))).toEqual({
      kind: 'missing',
      n: 2,
    });
    expect(entryChipOf('ready', productionStatus([]))).toEqual({ kind: 'ok' });
  });

  it('is "not checked" when the call failed before any answer', () => {
    expect(entryChipOf('error', null)).toEqual({ kind: 'unknown' });
  });
});

describe('projectEntryChipOf', () => {
  it('checks while a call runs, then counts the required missing ones, else all set', () => {
    expect(projectEntryChipOf('loading', productionStatus([], 'storify'))).toEqual({ kind: 'checking' });
    expect(
      projectEntryChipOf(
        'ready',
        productionStatus(
          ['project/storify/ROUTINE_TOKEN_STORIFY', 'project/storify/SLOT_TOKEN_STORIFY_PM'],
          'storify',
        ),
      ),
    ).toEqual({ kind: 'missing', n: 1 });
    expect(
      projectEntryChipOf('ready', productionStatus(['project/storify/SLOT_TOKEN_STORIFY_PM'], 'storify')),
    ).toEqual({ kind: 'ok' });
  });

  it('is "not checked" after a failure, even with an earlier answer, and where the console cannot see them', () => {
    expect(projectEntryChipOf('error', productionStatus([], 'storify'))).toEqual({ kind: 'unknown' });
    expect(projectEntryChipOf('ready', { environment: 'local', items: [] })).toEqual({ kind: 'unknown' });
  });
});

describe('projectEnvironmentViewOf', () => {
  it('on a production console: one section, this console, required then optional, optional never counted', () => {
    const view = projectEnvironmentViewOf({
      slug: 'storify',
      thisEnvironment: 'production',
      snapshot: productionStatus(
        ['project/storify/ROUTINE_TOKEN_STORIFY', 'project/storify/SLOT_TOKEN_STORIFY_QA'],
        'storify',
      ),
    });
    expect(view.sections).toHaveLength(1);
    const [section] = view.sections;
    expect(section?.environment).toBe('production');
    expect(section?.isThisConsole).toBe(true);
    expect(section?.required.map((row) => [row.row.name, row.status])).toEqual([
      ['ROUTINE_TOKEN_STORIFY', 'missing'],
    ]);
    expect(section?.optional.map((row) => row.row.name)).toEqual([
      'SLOT_TOKEN_STORIFY_PM',
      'SLOT_ROUTINE_STORIFY_PM',
      'SLOT_TOKEN_STORIFY_DEV',
      'SLOT_ROUTINE_STORIFY_DEV',
      'SLOT_TOKEN_STORIFY_QA',
      'SLOT_ROUTINE_STORIFY_QA',
    ]);
    expect(section?.missing).toBe(1);
    expect(section?.optionalMissing).toBe(1);
    expect(section?.firstMissing?.row.name).toBe('ROUTINE_TOKEN_STORIFY');
    expect(view.quiet).toEqual(['dev', 'stage', 'local']);
    expect(view.rows.every((row) => row.row.project === 'storify')).toBe(true);
  });

  it('on a local console: production is not visible from here, and local joins the quiet line', () => {
    const view = projectEnvironmentViewOf({
      slug: 'storify',
      thisEnvironment: 'local',
      snapshot: { environment: 'local', items: [] },
    });
    expect(view.sections.map((section) => [section.environment, section.isThisConsole])).toEqual([
      ['production', false],
    ]);
    expect(view.rows.every((row) => row.status === 'unseen')).toBe(true);
    expect(view.sections[0]?.missing).toBe(0);
    expect(view.quiet).toEqual(['dev', 'stage', 'local']);
  });

  it('shows no status before the first answer on the console that can see the rows', () => {
    const view = projectEnvironmentViewOf({ slug: 'storify', thisEnvironment: 'production', snapshot: null });
    expect(view.rows.every((row) => row.status === 'unknown')).toBe(true);
  });
});

describe('guideSourceOf', () => {
  it.each([
    ['OWNER_EMAIL', 'owner'],
    ['GITHUB_APP_PRIVATE_KEY', 'app'],
    ['VAPID_PRIVATE_KEY', 'generated'],
    ['ENVIRONMENT', 'fixed'],
  ])('%s → %s', (name, source) => {
    expect(guideSourceOf(item(name))).toBe(source);
  });
});

describe('proseSegmentsOf', () => {
  it('turns backtick spans into code, everything as text', () => {
    expect(proseSegmentsOf('Run `setup --rotate` then <b>wait</b>')).toEqual([
      { text: 'Run ', code: false },
      { text: 'setup --rotate', code: true },
      { text: ' then <b>wait</b>', code: false },
    ]);
  });
});
