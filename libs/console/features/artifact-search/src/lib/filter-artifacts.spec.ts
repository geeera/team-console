import type { Artifact } from '@console/entities/artifact';
import { ARTIFACT_TYPES } from '@shared/contracts';
import { artifactTypeCounts, filterArtifacts } from './filter-artifacts';

function artifact(index: number): Artifact {
  const type = ARTIFACT_TYPES[index % ARTIFACT_TYPES.length] ?? 'decision';
  return {
    type,
    title: `${String(index).padStart(4, '0')} — ${type === 'decision' ? 'Решение о стеке' : 'Board phone lanes'} ${index}`,
    url: `https://github.com/o/r/issues/${index}`,
    updatedAt: null,
    source: 'issue',
    state: 'open',
  };
}

const ITEMS = Array.from({ length: 250 }, (_, index) => artifact(index + 1));

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe('filterArtifacts', () => {
  it('returns the same list when nothing is chosen', () => {
    expect(filterArtifacts(ITEMS, { type: null, query: '  ' })).toBe(ITEMS);
  });

  it('keeps one type', () => {
    const designs = filterArtifacts(ITEMS, { type: 'design', query: '' });
    expect(designs.length).toBe(artifactTypeCounts(ITEMS).design);
    expect(designs.every((item) => item.type === 'design')).toBe(true);
  });

  it('matches every word of the query in any order, ignoring case (Cyrillic too)', () => {
    expect(
      filterArtifacts(ITEMS, { type: null, query: 'СТЕКЕ решение 0003' }).map((item) => item.url),
    ).toEqual(['https://github.com/o/r/issues/3']);
    expect(filterArtifacts(ITEMS, { type: 'demo', query: 'lanes 0002' })).toHaveLength(1);
    expect(filterArtifacts(ITEMS, { type: null, query: 'nothing-like-this' })).toEqual([]);
  });

  it('treats markup in the query as text', () => {
    const items = [{ ...artifact(1), title: '<b>bold</b> plan' }];
    expect(filterArtifacts(items, { type: null, query: '<b>' })).toHaveLength(1);
  });

  it('filters 250 artifacts in well under one frame (median of 20 runs < 16 ms)', () => {
    const runs = Array.from({ length: 20 }, (_, run) => {
      const started = performance.now();
      filterArtifacts(ITEMS, { type: run % 2 === 0 ? null : 'design', query: `lanes ${run}` });
      return performance.now() - started;
    });
    expect(median(runs)).toBeLessThan(16);
  });
});

describe('artifactTypeCounts', () => {
  it('counts every type, zero included', () => {
    expect(artifactTypeCounts([artifact(1), artifact(4)])).toEqual({ decision: 0, design: 2, demo: 0 });
  });
});
