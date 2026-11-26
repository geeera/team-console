import { ACTIONS_SETUP_STATUSES } from '@shared/contracts';
import { actionsDriftOf } from './actions-drift';

const checkedAt = '2026-11-20T09:00:00.000Z';
const judged = 'a'.repeat(64);
const now = 'b'.repeat(64);

describe('actionsDriftOf (#874)', () => {
  it.each(['missing', 'outdated', 'unsupported', 'modified'] as const)(
    'is drift when the check stored %s',
    (status) => {
      expect(actionsDriftOf({ status, sha256: judged, checkedAt }, judged)).toEqual({
        drift: status,
        checkedAt,
      });
      // The stored word stands on its own: neither another rendering nor none at all changes it.
      expect(actionsDriftOf({ status, sha256: null, checkedAt }, null)).toEqual({ drift: status, checkedAt });
    },
  );

  it('is no drift for a file that matched the rendering this console still renders', () => {
    expect(actionsDriftOf({ status: 'ok', sha256: now, checkedAt }, now)).toBeNull();
  });

  it('is release drift for a file that matched an earlier rendering', () => {
    expect(actionsDriftOf({ status: 'ok', sha256: judged, checkedAt }, now)).toEqual({
      drift: 'release',
      checkedAt,
    });
  });

  it('claims no release drift when either rendering is unknown', () => {
    expect(actionsDriftOf({ status: 'ok', sha256: judged, checkedAt }, null)).toBeNull();
    expect(actionsDriftOf({ status: 'ok', sha256: null, checkedAt }, now)).toBeNull();
  });

  it('is no drift for unknown (a permission the page asks for) or wrong (never a workflow status)', () => {
    expect(actionsDriftOf({ status: 'unknown', sha256: judged, checkedAt }, now)).toBeNull();
    expect(actionsDriftOf({ status: 'wrong', sha256: judged, checkedAt }, now)).toBeNull();
  });

  it('judges every status the check can store', () => {
    const drifting = ACTIONS_SETUP_STATUSES.filter(
      (status) => actionsDriftOf({ status, sha256: now, checkedAt }, now) !== null,
    );
    expect(drifting).toEqual(['missing', 'outdated', 'unsupported', 'modified']);
  });
});
