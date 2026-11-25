import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT_BASE,
  portsFor,
  STREAM_PORT_SPAN,
  streamPortBase,
  streamSuffix,
  WORKER_SLOTS_PER_STREAM,
} from './stack-ports';

function allPorts(rawBase: string | undefined): number[] {
  return Array.from({ length: WORKER_SLOTS_PER_STREAM }, (_, slot) =>
    Object.values(portsFor(slot, rawBase)),
  ).flat();
}

describe('streamPortBase', () => {
  it('is the default when E2E_PORT_BASE is not set', () => {
    expect(streamPortBase(undefined)).toBe(DEFAULT_PORT_BASE);
    expect(streamPortBase('')).toBe(DEFAULT_PORT_BASE);
  });

  it('takes a multiple of 100', () => {
    expect(streamPortBase('8700')).toBe(8700);
    expect(streamPortBase('1100')).toBe(1100);
    expect(streamPortBase('65400')).toBe(65_400);
  });

  it.each(['8750', '8701', 'abc', '87.5', '1000', '0', '-8700', '65500', '70000'])(
    'throws on %s instead of falling back to another run’s ports',
    (raw) => {
      expect(() => streamPortBase(raw)).toThrow(/E2E_PORT_BASE=.* is not a port base/);
    },
  );
});

describe('portsFor', () => {
  it('keeps the default layout: ten ports per worker slot from 18700', () => {
    expect(portsFor(0, undefined)).toEqual({
      api: 18_700,
      fake: 18_701,
      apiInspector: 18_702,
      fakeInspector: 18_703,
      fakePush: 18_704,
      fakePushInspector: 18_705,
    });
    expect(portsFor(1, undefined).api).toBe(18_710);
  });

  it('derives every port, the inspectors included, from E2E_PORT_BASE', () => {
    expect(portsFor(1, '8700')).toEqual({
      api: 8710,
      fake: 8711,
      apiInspector: 8712,
      fakeInspector: 8713,
      fakePush: 8714,
      fakePushInspector: 8715,
    });
  });

  it('gives no two servers or inspectors of one run the same port', () => {
    const ports = allPorts('8700');

    expect(new Set(ports).size).toBe(ports.length);
  });

  it('keeps every port of a run inside its own hundred, whatever the slot', () => {
    for (const port of allPorts('8700')) {
      expect(port).toBeGreaterThanOrEqual(8700);
      expect(port).toBeLessThan(8700 + STREAM_PORT_SPAN);
    }
  });

  it('gives two runs with different bases no port in common, neighbours included', () => {
    const taken = new Set([...allPorts('8700'), ...allPorts(undefined)]);

    for (const other of ['8600', '8800', '8900', '18600', '18800']) {
      expect(allPorts(other).filter((port) => taken.has(port))).toEqual([]);
    }
  });

  it('reads E2E_PORT_BASE from the environment by default', () => {
    const before = process.env['E2E_PORT_BASE'];
    process.env['E2E_PORT_BASE'] = '8900';
    try {
      expect(portsFor(0).api).toBe(8900);
    } finally {
      if (before === undefined) {
        delete process.env['E2E_PORT_BASE'];
      } else {
        process.env['E2E_PORT_BASE'] = before;
      }
    }
  });

  it.each([-1, 10, 1.5])('throws on worker slot %s, which has no ports in the run’s range', (slot) => {
    expect(() => portsFor(slot, '8700')).toThrow(/No ports for worker slot/);
  });
});

describe('streamSuffix', () => {
  it('is empty for the default run, so CI keeps tmp/console-e2e', () => {
    expect(streamSuffix(undefined)).toBe('');
    expect(streamSuffix('')).toBe('');
  });

  it('names the run by its base', () => {
    expect(streamSuffix('8700')).toBe('-8700');
  });

  it('throws on a value that is not a base', () => {
    expect(() => streamSuffix('8750')).toThrow(/is not a port base/);
  });
});
