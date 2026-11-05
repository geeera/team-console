import { base64urlOfText, localJobToken } from '../testing/local-job-kit';
import { JOB_ROLES } from './job-roles';
import { bearerOf, parseLocalJobToken } from './local-job';

// #444: the local stand-in's shape. Anything but exactly the documented payload is refused (null), never coerced.

const VALID = { role: 'dev', project_slug: 'acme-1', job_id: 'job-2026.11:a_b', items: [12, 3] };

describe('parseLocalJobToken', () => {
  it('reads the documented payload into the job identity', () => {
    expect(parseLocalJobToken(localJobToken(VALID))).toEqual({
      kind: 'job',
      role: 'dev',
      projectSlug: 'acme-1',
      jobId: 'job-2026.11:a_b',
      items: [12, 3],
    });
  });

  it.each(JOB_ROLES)('accepts the role %s', (role) => {
    expect(parseLocalJobToken(localJobToken({ ...VALID, role }))?.role).toBe(role);
  });

  it('keeps each item once and accepts a job that holds none', () => {
    expect(parseLocalJobToken(localJobToken({ ...VALID, items: [5, 5, 6] }))?.items).toEqual([5, 6]);
    expect(parseLocalJobToken(localJobToken({ ...VALID, items: [] }))?.items).toEqual([]);
  });

  it.each([
    ['an unknown role', { ...VALID, role: 'owner' }],
    ['a role variant that is not a role', { ...VALID, role: 'qa-runner' }],
    ['a role in another case', { ...VALID, role: 'PM' }],
    ['a slug with a slash', { ...VALID, project_slug: 'a/b' }],
    ['an upper-case slug', { ...VALID, project_slug: 'Acme' }],
    ['an empty slug', { ...VALID, project_slug: '' }],
    ['a job id with a space', { ...VALID, job_id: 'job 1' }],
    ['an over-long job id', { ...VALID, job_id: 'j'.repeat(65) }],
    ['a number as job id', { ...VALID, job_id: 7 }],
    ['items not a list', { ...VALID, items: 3 }],
    ['an item of 0', { ...VALID, items: [0] }],
    ['a fractional item', { ...VALID, items: [1.5] }],
    ['an item as text', { ...VALID, items: ['1'] }],
    ['101 items', { ...VALID, items: Array.from({ length: 101 }, (_, index) => index + 1) }],
    ['a missing member', { role: 'pm', project_slug: 'acme', job_id: 'j' }],
    ['an extra member', { ...VALID, owner: true }],
    ['camel-case members', { role: 'pm', projectSlug: 'acme', jobId: 'j', items: [] }],
    ['a list', [VALID]],
    ['null', null],
    ['a string', 'pm'],
  ])('refuses %s', (_, payload) => {
    expect(parseLocalJobToken(localJobToken(payload))).toBeNull();
  });

  it.each([
    ['no prefix', base64urlOfText(JSON.stringify(VALID))],
    ['another prefix', `local-owner.${base64urlOfText(JSON.stringify(VALID))}`],
    ['an empty payload', 'local-job.'],
    ['standard base64 padding', `local-job.${btoa(JSON.stringify(VALID))}==`],
    ['characters outside base64url', 'local-job.eyJ+cm9sZSI6InBtIn0/'],
    ['not JSON', `local-job.${base64urlOfText('role=pm')}`],
    ['invalid UTF-8', `local-job.${btoa(String.fromCharCode(0xff, 0xfe)).replace(/=+$/, '')}`],
    ['an over-long token', `local-job.${'A'.repeat(5000)}`],
  ])('refuses a token with %s', (_, token) => {
    expect(parseLocalJobToken(token)).toBeNull();
  });
});

describe('bearerOf', () => {
  it('tells no header, a stand-in and anything else apart', () => {
    expect(bearerOf(undefined)).toEqual({ kind: 'none' });
    expect(bearerOf('   ')).toEqual({ kind: 'none' });
    expect(bearerOf('Bearer local-job.abc')).toEqual({ kind: 'local-job', token: 'local-job.abc' });
    expect(bearerOf('  Bearer   local-job.abc  ')).toEqual({ kind: 'local-job', token: 'local-job.abc' });
    expect(bearerOf('Bearer eyJhbGciOi')).toEqual({ kind: 'other' });
    expect(bearerOf('Basic local-job.abc')).toEqual({ kind: 'other' });
    expect(bearerOf('local-job.abc')).toEqual({ kind: 'other' });
    expect(bearerOf('Bearer local-job.a b')).toEqual({ kind: 'other' });
  });
});
