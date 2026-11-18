import { env } from 'cloudflare:test';
import { DISPLAY_NAME_MAX_LENGTH, displayNameOf, UsersRepo } from './users.repo';

const T0 = '2026-11-18T10:00:00.000Z';

describe('displayNameOf', () => {
  it('keeps a plain name, trimmed, with its inner spaces collapsed', () => {
    expect(displayNameOf('  Анна   Петрова ')).toBe('Анна Петрова');
    expect(displayNameOf('מרים')).toBe('מרים');
  });

  // R-INT-7's classes: a name cannot rearrange the sentence it is put in, or break it over lines.
  it.each([
    ['a bidi override', 'Anna‮evil', 'Annaevil'],
    ['an isolate', '⁦Anna⁩', 'Anna'],
    ['a zero-width space', 'An​na', 'Anna'],
    ['a line separator', 'Anna Boris', 'AnnaBoris'],
    ['a paragraph separator', 'Anna ', 'Anna'],
    ['a newline and a tab', 'Anna\n\tB', 'AnnaB'],
    ['a C1 control', 'Anna\u0085', 'Anna'],
  ])('strips %s', (_name, raw, expected) => {
    expect(displayNameOf(raw)).toBe(expected);
  });

  it.each([
    ['null', null],
    ['a number', 42],
    ['an empty string', ''],
    ['spaces only', '   '],
    ['format characters only', '‮⁦​'],
  ])('is null for %s', (_name, raw) => {
    expect(displayNameOf(raw)).toBeNull();
  });

  it('cuts a long name to the column’s bound, by code points', () => {
    const name = displayNameOf('😀'.repeat(DISPLAY_NAME_MAX_LENGTH + 10));
    expect([...(name ?? '')]).toHaveLength(DISPLAY_NAME_MAX_LENGTH);
  });
});

describe('UsersRepo.refreshDisplayName', () => {
  const repo = new UsersRepo(env.DB);
  const USER = '01M6YSNJ00000000000000DN01';

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at)
       VALUES (?1, 'github', '775001', 'names-user', ?2, ?2)`,
    )
      .bind(USER, T0)
      .run();
  });

  it('writes the cleaned name, refreshes it later, and clears it when the profile has none', async () => {
    await expect(repo.refreshDisplayName('github', '775001', ' Анна‮ ')).resolves.toBe(true);
    expect((await repo.findById(USER))?.displayName).toBe('Анна');
    await expect(repo.refreshDisplayName('github', '775001', 'Анна')).resolves.toBe(false);
    await expect(repo.refreshDisplayName('github', '775001', 'Анна П.')).resolves.toBe(true);
    expect((await repo.findById(USER))?.displayName).toBe('Анна П.');
    await expect(repo.refreshDisplayName('github', '775001', null)).resolves.toBe(true);
    expect((await repo.findById(USER))?.displayName).toBeNull();
  });

  it('creates no user for a provider id it does not know', async () => {
    await expect(repo.refreshDisplayName('github', '775999', 'Nobody')).resolves.toBe(false);
    await expect(repo.findByProviderId('github', '775999')).resolves.toBeNull();
  });
});
