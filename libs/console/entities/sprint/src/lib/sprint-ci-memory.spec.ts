import { TestBed } from '@angular/core/testing';
import { SprintCiMemory } from './sprint-ci-memory';

describe('SprintCiMemory', () => {
  const memory = (): SprintCiMemory => TestBed.inject(SprintCiMemory);

  it('recalls the last state remembered for a key, and nothing for an unknown key', () => {
    memory().remember('p#1', 'pending');
    memory().remember('p#1', 'success');
    expect(memory().recall('p#1')).toBe('success');
    expect(memory().recall('p#2')).toBeNull();
  });

  it('forgets the oldest pull request once it holds more than it keeps', () => {
    for (let n = 0; n < 201; n += 1) {
      memory().remember(`p#${String(n)}`, 'pending');
    }
    expect(memory().recall('p#0')).toBeNull();
    expect(memory().recall('p#1')).toBe('pending');
    expect(memory().recall('p#200')).toBe('pending');
  });

  it('keeps a pull request that was just seen again when it drops the oldest', () => {
    for (let n = 0; n < 200; n += 1) {
      memory().remember(`p#${String(n)}`, 'pending');
    }
    memory().remember('p#0', 'success');
    memory().remember('p#new', 'pending');
    expect(memory().recall('p#0')).toBe('success');
    expect(memory().recall('p#1')).toBeNull();
  });
});
