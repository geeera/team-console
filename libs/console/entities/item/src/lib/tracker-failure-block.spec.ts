import { copyKeyOf } from './tracker-failure-block';
import type { TrackerFailure } from './tracker-failure';

const failure = (kind: TrackerFailure['kind'], field: string | null = null): TrackerFailure => ({
  kind,
  field,
  retryAfter: null,
});

// #470 item 3: `decision-command` and `item-closed` both read "no longer waiting" (the `gone` kind) — pin that the
// one naming the `command` field gets its own copy key, the other kinds keep the shared one.
describe('copyKeyOf', () => {
  it('reads decision-command (the `gone` problem naming the command field) as its own copy', () => {
    expect(copyKeyOf(failure('gone', 'command'))).toBe('decisionGone');
  });

  it('reads item-closed, ask-not-open and ask-imported — none of which name a field — as the shared copy', () => {
    expect(copyKeyOf(failure('gone', null))).toBe('gone');
  });

  it('leaves every other kind on its own copy, untouched by the field', () => {
    expect(copyKeyOf(failure('conflict'))).toBe('changed');
    expect(copyKeyOf(failure('invalid', 'command'))).toBe('invalid');
    expect(copyKeyOf(failure('not-found'))).toBe('notFound');
  });
});
