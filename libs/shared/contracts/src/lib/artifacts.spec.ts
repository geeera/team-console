import { isArtifactType, isArtifactsPartial } from './artifacts';

describe('artifact guards', () => {
  it('accepts the three artifact types only', () => {
    expect(['decision', 'design', 'demo'].every(isArtifactType)).toBe(true);
    expect(isArtifactType('release')).toBe(false);
    expect(isArtifactType(1)).toBe(false);
  });

  it('accepts a type or a known partial reason', () => {
    expect(isArtifactsPartial('decision-titles')).toBe(true);
    expect(isArtifactsPartial('demo')).toBe(true);
    expect(isArtifactsPartial('everything')).toBe(false);
  });
});
