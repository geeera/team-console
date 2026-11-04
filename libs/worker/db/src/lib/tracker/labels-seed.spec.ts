import { env } from 'cloudflare:test';
import { COLUMN_LABEL_PREFIXES } from '@shared/contracts';
import { LABELS_SEED } from './labels-seed';
import seed from './labels-seed.json';

describe('LABELS_SEED', () => {
  it('was generated from the vendored plugin as it is now (else: run scripts/generate-labels-seed.py)', () => {
    expect(seed.plugin.version).toBe(env.TEST_PLUGIN_VERSION);
    expect(seed.plugin.sources['scripts/ptlib/labels.py']).toBe(env.TEST_PLUGIN_LABELS_SHA256);
  });

  it('holds every status, kind, severity and tier label the item columns map to', () => {
    const names = LABELS_SEED.map((label) => label.name);
    expect(names).toEqual(
      expect.arrayContaining(['status:proposed', 'kind:bug', 'sev:critical', 'tier:heavy']),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('holds the owner-semantic flags the transition table guards', () => {
    const names = LABELS_SEED.map((label) => label.name);
    expect(names).toEqual(
      expect.arrayContaining(['design:approved', 'owner:scope', 'team:demo', 'release-blocker', 'security']),
    );
    expect(
      names.filter((name) => !COLUMN_LABEL_PREFIXES.some((prefix) => name.startsWith(prefix))),
    ).not.toEqual([]);
  });
});
