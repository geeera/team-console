import { routineSecretName, slotSecretNames } from '@shared/contracts';
import { ENVIRONMENT_GROUPS, environmentRowsOf, expandPattern } from './rows';

function ids(rows: ReturnType<typeof environmentRowsOf>): string[] {
  return rows.map((row) => row.id);
}

describe('expandPattern', () => {
  it('fills the slug the way the routine and slot secret names are spelled', () => {
    expect(expandPattern('ROUTINE_TOKEN_<SLUG>', 'team-console')).toEqual([
      routineSecretName('team-console'),
    ]);
    expect(expandPattern('SLOT_TOKEN_<SLUG>_<SLOT>', 'storify')).toEqual([
      slotSecretNames('storify', 'pm').token,
      slotSecretNames('storify', 'dev').token,
      slotSecretNames('storify', 'qa').token,
    ]);
    expect(expandPattern('SLOT_ROUTINE_<SLUG>_<SLOT>', 'storify')[0]).toBe(
      slotSecretNames('storify', 'pm').routine,
    );
  });
});

describe('environmentRowsOf', () => {
  it('lists the groups in screen order', () => {
    const rows = environmentRowsOf('production', ['storify']);
    const order = rows.map((row) => ENVIRONMENT_GROUPS.indexOf(row.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('puts an item that lives on both Workers in both groups, each with its own id', () => {
    const rows = environmentRowsOf('stage', []);
    expect(ids(rows)).toEqual(expect.arrayContaining(['api/VAPID_PRIVATE_KEY', 'hooks/VAPID_PRIVATE_KEY']));
    expect(rows.find((row) => row.id === 'api/VAPID_PRIVATE_KEY')?.binding).toBe('VAPID_PRIVATE_KEY');
    expect(rows.find((row) => row.id === 'hooks/VAPID_PRIVATE_KEY')?.binding).toBeNull();
  });

  it('checks a GitHub variable on the Worker it reaches, under its Worker name when deploy.yml renames it', () => {
    const rows = environmentRowsOf('dev', []);
    const binding = (id: string): string | null | undefined => rows.find((row) => row.id === id)?.binding;
    expect(binding('github-vars/ACCESS_AUD')).toBe('ACCESS_AUD');
    expect(binding('github-vars/CONSOLE_GITHUB_APP_ID')).toBe('GITHUB_APP_ID');
    expect(binding('github-vars/CONSOLE_GITHUB_APP_CLIENT_ID')).toBe('GITHUB_APP_CLIENT_ID');
    // Never passed to the Worker: the console cannot see it.
    expect(binding('github-vars/CONSOLE_GITHUB_APP_SLUG')).toBeNull();
    expect(ids(rows)).not.toContain('api/ACCESS_AUD');
  });

  it('never claims to see GitHub secrets, repository secrets or the hooks Worker', () => {
    const rows = environmentRowsOf('production', ['storify']);
    for (const row of rows.filter((candidate) =>
      ['hooks', 'github-secrets', 'repo'].includes(candidate.group),
    )) {
      expect(row.binding, row.id).toBeNull();
    }
    expect(ids(rows)).toEqual(
      expect.arrayContaining([
        'github-secrets/CLOUDFLARE_API_TOKEN',
        'repo/PT_TELEGRAM_TOKEN',
        'hooks/WEBHOOK_SECRET',
      ]),
    );
  });

  it('expands the per-project patterns for each project, production only (the manifest lists them there)', () => {
    const production = environmentRowsOf('production', ['storify', 'team-console']);
    const projectRows = production.filter((row) => row.group === 'projects');
    expect(projectRows.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        'project/storify/ROUTINE_TOKEN_STORIFY',
        'project/team-console/ROUTINE_TOKEN_TEAM_CONSOLE',
        'project/team-console/SLOT_TOKEN_TEAM_CONSOLE_QA',
        'project/storify/SLOT_ROUTINE_STORIFY_PM',
      ]),
    );
    expect(projectRows).toHaveLength(2 * 7);
    expect(projectRows.every((row) => row.binding === row.name)).toBe(true);
    expect(environmentRowsOf('stage', ['storify']).some((row) => row.group === 'projects')).toBe(false);
  });

  it('skips a slug that is not slug-shaped rather than building a name from it', () => {
    const rows = environmentRowsOf('production', ['../x', 'Storify', 'ok']);
    expect(rows.filter((row) => row.group === 'projects').every((row) => row.project === 'ok')).toBe(true);
  });

  it('lists only local-only items on local, each a --var of the local api Worker', () => {
    const rows = environmentRowsOf('local', []);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.group === 'local' && row.binding === row.name)).toBe(true);
    expect(ids(rows)).toContain('local/GITHUB_MOCK');
  });
});
