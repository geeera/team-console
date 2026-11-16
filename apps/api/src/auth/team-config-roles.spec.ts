import { TEAM_ROLES } from '@shared/contracts';
import { JOB_ROLES } from './job-roles';

// #687 (ADR 0009 "Schema"): `roles` of team-config/v1 has exactly the job roles a token can name, so a role added to
// one list and not the other fails here instead of becoming a role the schema refuses or the claim never admits.
describe('the team-config roles', () => {
  it('are the job roles, in the same order', () => {
    expect([...TEAM_ROLES]).toEqual([...JOB_ROLES]);
  });
});
