import { ownerResumeAtOf } from './owner-pause';
import type { RunLogComment } from './run-state';

let nextId = 1;
function comment(author: string, body: string, createdAt: string | null): RunLogComment {
  return { id: nextId++, body, createdAt, updatedAt: createdAt, author };
}

describe('ownerResumeAtOf', () => {
  it('is the newest `/resume` the owner wrote, whatever the login case', () => {
    const comments = [
      comment('Owner', '/resume', '2026-11-01T10:00:00Z'),
      comment('owner', 'Back to work.\n/resume', '2026-11-03T10:00:00Z'),
      comment('owner', '/resume', '2026-11-02T10:00:00Z'),
    ];

    expect(ownerResumeAtOf(comments, 'OWNER')).toBe('2026-11-03T10:00:00Z');
  });

  it("ignores the team's bot, other commands, quoted lines and team notes", () => {
    const comments = [
      comment('team-bot[bot]', '/resume', '2026-11-04T10:00:00Z'),
      comment('owner', '/approve', '2026-11-04T11:00:00Z'),
      comment('owner', '> /resume', '2026-11-04T12:00:00Z'),
      comment('owner', '**PM note**\n/resume', '2026-11-04T13:00:00Z'),
    ];

    expect(ownerResumeAtOf(comments, 'owner')).toBe('');
  });

  it("is '' without an owner or a timestamp", () => {
    expect(ownerResumeAtOf([comment('owner', '/resume', null)], 'owner')).toBe('');
    expect(ownerResumeAtOf([comment('', '/resume', '2026-11-04T10:00:00Z')], '')).toBe('');
    expect(ownerResumeAtOf([], 'owner')).toBe('');
  });
});
