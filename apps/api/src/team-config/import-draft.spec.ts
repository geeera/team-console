import type { TeamConfigImportNote } from '@shared/contracts';
import { pick } from './import-draft';

describe('pick (#708: array elements must be deep-copied before the guard copy)', () => {
  it('deep-copies a plain-object array element, not just the array wrapper', () => {
    const notes: TeamConfigImportNote[] = [];
    const nested = { depth: 1 };
    const source = { code_paths: [nested] };

    const copy = pick(source, ['code_paths'], 'gates', notes);
    const copiedElement = (copy?.['code_paths'] as unknown[])[0] as { depth: number };

    expect(copiedElement).toEqual(nested);
    expect(copiedElement).not.toBe(nested);

    // Mutating the source after the call must never reach the picked copy.
    nested.depth = 2;
    expect(copiedElement.depth).toBe(1);
  });

  it("strips a forged prototype on an array's object element the same way checkTeamConfig's final copy would", () => {
    const forged: Record<string, unknown> = Object.create({ polluted: true });
    forged['safe'] = 'x';
    const source = { code_paths: [forged] };

    const copy = pick(source, ['code_paths'], 'gates', []);
    const copiedElement = (copy?.['code_paths'] as unknown[])[0];

    expect(Object.getPrototypeOf(copiedElement)).toBe(Object.prototype);
    expect((copiedElement as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('still copies a plain string array (the only array field used today) without losing values', () => {
    const copy = pick({ code_paths: ['apps/**', 'libs/**'] }, ['code_paths'], 'gates', []);
    expect(copy?.['code_paths']).toEqual(['apps/**', 'libs/**']);
  });
});
