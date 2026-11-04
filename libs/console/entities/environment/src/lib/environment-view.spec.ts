import { ENVIRONMENT_MANIFEST, environmentRowsOf, type EnvironmentStatusDto } from '@shared/environment';
import {
  entryChipOf,
  environmentViewOf,
  guideSourceOf,
  projectSlugsOf,
  proseSegmentsOf,
  type EnvironmentView,
} from './environment-view';

function item(name: string) {
  const found = ENVIRONMENT_MANIFEST.items.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no manifest item ${name}`);
  }
  return found;
}

/** Every row production's Worker can see, all set but the given ids. */
function productionStatus(
  missing: readonly string[],
  slugs: readonly string[] = ['storify'],
): EnvironmentStatusDto {
  return {
    environment: 'production',
    items: environmentRowsOf('production', slugs)
      .filter((row) => row.binding !== null)
      .map((row) => ({ id: row.id, status: missing.includes(row.id) ? 'missing' : 'set' })),
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
      projectSlugs: ['storify'],
      snapshot: productionStatus(['api/VAPID_PRIVATE_KEY', 'project/storify/ROUTINE_TOKEN_STORIFY']),
    });

    const byId = statusById(view);
    expect(byId.get('api/VAPID_PRIVATE_KEY')).toBe('missing');
    expect(byId.get('api/OWNER_EMAIL')).toBe('set');
    expect(byId.get('hooks/VAPID_PRIVATE_KEY')).toBe('unseen');
    expect(byId.get('github-secrets/CLOUDFLARE_API_TOKEN')).toBe('unseen');
    const api = view.groups.find((group) => group.group === 'api');
    expect(api?.rows[0]?.row.id).toBe('api/VAPID_PRIVATE_KEY');
    expect(view.missing).toBe(2);
    expect(view.firstMissing?.row.id).toBe('api/VAPID_PRIVATE_KEY');
    expect(view.unseen).toBeGreaterThan(0);
  });

  it('never counts an optional item as missing', () => {
    const view = environmentViewOf({
      environment: 'production',
      thisEnvironment: 'production',
      projectSlugs: ['storify'],
      snapshot: productionStatus(['project/storify/SLOT_TOKEN_STORIFY_PM']),
    });
    expect(statusById(view).get('project/storify/SLOT_TOKEN_STORIFY_PM')).toBe('missing');
    expect(view.missing).toBe(0);
    expect(view.firstMissing).toBeNull();
  });

  it("on another environment's tab every row is not visible here, whatever the snapshot says", () => {
    const view = environmentViewOf({
      environment: 'stage',
      thisEnvironment: 'production',
      projectSlugs: [],
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
      projectSlugs: [],
      snapshot: null,
    });
    expect(statusById(view).get('api/OWNER_EMAIL')).toBe('unknown');
    expect(statusById(view).get('hooks/WEBHOOK_SECRET')).toBe('unseen');
  });

  it('groups per-project rows in one block per project with its own count', () => {
    const view = environmentViewOf({
      environment: 'production',
      thisEnvironment: 'production',
      projectSlugs: ['storify', 'team-console'],
      snapshot: productionStatus(['project/storify/ROUTINE_TOKEN_STORIFY'], ['storify', 'team-console']),
    });
    const projects = view.groups.find((group) => group.group === 'projects')?.projects ?? [];
    expect(projects.map((block) => block.slug)).toEqual(['storify', 'team-console']);
    expect(projects[0]).toMatchObject({ total: 7, set: 6, hasMissing: true });
    expect(projects[1]).toMatchObject({ total: 7, set: 7, hasMissing: false });
  });

  it('keeps the Projects group on production with no projects, so it can say so', () => {
    const view = environmentViewOf({
      environment: 'production',
      thisEnvironment: 'dev',
      projectSlugs: [],
      snapshot: null,
    });
    expect(view.groups.find((group) => group.group === 'projects')?.projects).toEqual([]);
    expect(
      environmentViewOf({
        environment: 'dev',
        thisEnvironment: 'dev',
        projectSlugs: [],
        snapshot: null,
      }).groups.some((group) => group.group === 'projects'),
    ).toBe(false);
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

describe('projectSlugsOf', () => {
  it('reads the slugs out of per-project ids', () => {
    expect(projectSlugsOf(productionStatus([], ['storify', 'team-console']))).toEqual([
      'storify',
      'team-console',
    ]);
    expect(projectSlugsOf(null)).toEqual([]);
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
