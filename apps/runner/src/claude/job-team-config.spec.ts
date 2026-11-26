import { resolveTeamConfig, type ResolvedTeamConfigDto, type TeamCost } from '@shared/contracts';
import { LaunchRefusal } from '../jobs/refusal';
import { launchPlanOf, teamConfigNoticeOf } from './job-team-config';
import { ROLE_MODELS } from './roles';

/** ADR 0009 d.5, d.6, T5, T7, T11: the launch plan of one job from the claim's resolved view. */

const viewOf = (
  source: 'api_key' | 'subscription',
  cost: Partial<TeamCost> = {},
  preset: 'economy' | 'recommended' | 'max' = 'economy',
): ResolvedTeamConfigDto =>
  resolveTeamConfig(
    { schema: 'team-config/v1', preset, access: { source }, cost },
    { revision: 3, accessSource: source },
  );

function refusalOf(role: string, teamConfig: unknown): LaunchRefusal {
  try {
    launchPlanOf(role, teamConfig);
  } catch (error: unknown) {
    if (error instanceof LaunchRefusal) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('launchPlanOf', () => {
  it.each(Object.keys(ROLE_MODELS))('takes %s’s model, turn limit and effort from the view', (role) => {
    const view = viewOf('api_key', {}, 'max');
    const entry = view.roles[role as keyof typeof ROLE_MODELS];
    const plan = launchPlanOf(role, view);
    expect(plan).toMatchObject({
      model: entry.model,
      maxTurns: entry.max_turns,
      settings: { effort: entry.effort, promptCaching: true },
      accessSource: 'api_key',
      revision: 3,
    });
  });

  it('falls back to ROLE_MODELS without a view, with no turn limit, effort or source check', () => {
    expect(launchPlanOf('reviewer', undefined)).toEqual({
      role: 'reviewer',
      model: ROLE_MODELS.reviewer,
      maxTurns: null,
      settings: { effort: null, promptCaching: true },
      accessSource: null,
      clone: 'full',
      cost: { prompt_caching: 'not-applied', batch_api: 'not-applied', reviewer_context: 'not-applied' },
      revision: null,
    });
  });

  it('refuses a role the runner has no prompt for before it reads the view', () => {
    expect(refusalOf('dev', viewOf('api_key')).reason).toBe('role-unknown');
  });

  it.each([null, {}, 'team-config/v1', { ...viewOf('api_key'), revision: -1 }])(
    'refuses a view the shared guard refuses (%j) without naming its values',
    (view) => {
      const refusal = refusalOf('pm', view);
      expect(refusal.reason).toBe('team-config-invalid');
      expect(refusal.message).toBe('the claim’s team configuration is not a valid team-config/v1 view');
    },
  );

  it('refuses a model shaped as a second flag', () => {
    const view = viewOf('api_key');
    const forged = {
      ...view,
      roles: { ...view.roles, pm: { ...view.roles.pm, model: 'claude-opus-5-5 --verbose' } },
    };
    expect(refusalOf('pm', forged).reason).toBe('team-config-invalid');
  });

  describe('cost levers (api_key only)', () => {
    it('diff context narrows the reviewer’s clone only', () => {
      const view = viewOf('api_key', { reviewer_context: 'diff' });
      expect(launchPlanOf('reviewer', view)).toMatchObject({
        clone: 'diff',
        cost: { reviewer_context: 'applied' },
      });
      for (const role of ['security', 'qa', 'pm', 'orchestrator']) {
        expect(launchPlanOf(role, view)).toMatchObject({
          clone: 'full',
          cost: { reviewer_context: 'not-applicable' },
        });
      }
    });

    it('repo context keeps the full clone and says off', () => {
      expect(launchPlanOf('reviewer', viewOf('api_key', { reviewer_context: 'repo' }))).toMatchObject({
        clone: 'full',
        cost: { reviewer_context: 'off' },
      });
    });

    it('prompt caching off sets the settings, batch_api on under api_key reports unsupported', () => {
      const plan = launchPlanOf('pm', viewOf('api_key', { prompt_caching: false, batch_api: true }));
      expect(plan.settings.promptCaching).toBe(false);
      expect(plan.cost).toMatchObject({ prompt_caching: 'off', batch_api: 'unsupported' });
    });

    it('batch_api off under api_key stays off, not unsupported', () => {
      const plan = launchPlanOf('pm', viewOf('api_key', { batch_api: false }));
      expect(plan.cost).toMatchObject({ batch_api: 'off' });
    });

    it('a subscription project ignores every lever: full clone, caching untouched', () => {
      const plan = launchPlanOf(
        'reviewer',
        viewOf('subscription', { prompt_caching: false, batch_api: true, reviewer_context: 'diff' }),
      );
      expect(plan).toMatchObject({
        accessSource: 'subscription',
        clone: 'full',
        settings: { promptCaching: true },
        cost: { prompt_caching: 'not-applied', batch_api: 'not-applied', reviewer_context: 'not-applied' },
      });
    });
  });

  it('reports enums, ids and numbers only', () => {
    expect(teamConfigNoticeOf(launchPlanOf('reviewer', viewOf('api_key')))).toEqual({
      teamConfig: {
        revision: 3,
        source: 'api_key',
        model: 'claude-sonnet-5',
        maxTurns: 400,
        effort: 'medium',
        clone: 'diff',
      },
      cost: { prompt_caching: 'applied', batch_api: 'off', reviewer_context: 'applied' },
    });
  });
});
