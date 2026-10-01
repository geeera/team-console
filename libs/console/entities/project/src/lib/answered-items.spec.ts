import { TestBed } from '@angular/core/testing';
import {
  ANSWERED_ITEMS_NOW,
  ANSWERED_ITEMS_STORAGE,
  ANSWERED_ITEMS_TTL_MS,
  AnsweredItem,
  AnsweredItems,
  AnsweredItemsStorage,
  parseAnsweredItems,
} from './answered-items';

const T0 = Date.parse('2026-10-01T10:00:00Z');

function answer(slug: string, number: number, at = T0): AnsweredItem {
  return {
    slug,
    number,
    command: 'approve',
    url: `https://github.com/geeera/${slug}/issues/${number}#issuecomment-${number}`,
    answeredAt: new Date(at).toISOString(),
  };
}

function memory(initial: string | null = null): AnsweredItemsStorage & { value: string | null } {
  return {
    value: initial,
    read() {
      return this.value;
    },
    write(value: string) {
      this.value = value;
    },
  };
}

describe('parseAnsweredItems', () => {
  it('keeps valid answers younger than the TTL and drops the rest', () => {
    const raw = JSON.stringify([
      answer('tc', 1),
      answer('tc', 2, T0 - ANSWERED_ITEMS_TTL_MS),
      { ...answer('tc', 3), command: '/approve' },
      { ...answer('tc', 4), number: '4' },
      'junk',
    ]);

    expect(parseAnsweredItems(raw, T0 + 1000).map((item) => item.number)).toEqual([1]);
  });

  it('starts empty on nothing stored, corrupt JSON or a non-array', () => {
    expect(parseAnsweredItems(null, T0)).toEqual([]);
    expect(parseAnsweredItems('{', T0)).toEqual([]);
    expect(parseAnsweredItems('{"tc#1":{}}', T0)).toEqual([]);
  });
});

describe('AnsweredItems', () => {
  let now: number;
  let storage: ReturnType<typeof memory>;

  function create(initial: string | null = null): AnsweredItems {
    storage = memory(initial);
    TestBed.configureTestingModule({
      providers: [
        { provide: ANSWERED_ITEMS_STORAGE, useValue: storage },
        { provide: ANSWERED_ITEMS_NOW, useValue: () => now },
      ],
    });
    return TestBed.inject(AnsweredItems);
  }

  beforeEach(() => {
    now = T0;
  });

  it('records an answer, persists it and restores it on the next launch', () => {
    const answered = create();
    answered.record(answer('tc', 72));

    expect(answered.has('tc', 72)).toBe(true);
    expect(answered.has('tc', 73)).toBe(false);
    expect(answered.has('other', 72)).toBe(false);
    expect(parseAnsweredItems(storage.value, now)).toEqual([answer('tc', 72)]);

    TestBed.resetTestingModule();
    expect(create(storage.value).get('tc', 72)).toEqual(answer('tc', 72));
  });

  it('forgets an answer after the TTL so a repeated question shows again', () => {
    const answered = create();
    answered.record(answer('tc', 72));

    now = T0 + ANSWERED_ITEMS_TTL_MS;

    expect(answered.has('tc', 72)).toBe(false);
  });

  it('reconcile() forgets answers no longer listed for the projects that were read, and only those', () => {
    const answered = create();
    answered.record(answer('tc', 72));
    answered.record(answer('tc', 73));
    answered.record(answer('storify', 5));

    answered.reconcile(['tc'], [{ slug: 'tc', number: 73 }]);

    expect(answered.has('tc', 72)).toBe(false);
    expect(answered.has('tc', 73)).toBe(true);
    expect(answered.has('storify', 5)).toBe(true);
    expect(parseAnsweredItems(storage.value, now).map((item) => item.number)).toEqual([73, 5]);
  });

  it('keeps working in memory when storage refuses the write', () => {
    storage = memory();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ANSWERED_ITEMS_STORAGE,
          useValue: {
            read: () => null,
            write: () => {
              throw new DOMException('quota', 'QuotaExceededError');
            },
          },
        },
        { provide: ANSWERED_ITEMS_NOW, useValue: () => now },
      ],
    });
    const answered = TestBed.inject(AnsweredItems);

    expect(() => answered.record(answer('tc', 72))).not.toThrow();
    expect(answered.has('tc', 72)).toBe(true);
  });

  it('treats a constructor slug as data', () => {
    const answered = create();

    expect(answered.has('constructor', 1)).toBe(false);
    answered.record(answer('constructor', 1));
    expect(answered.has('constructor', 1)).toBe(true);
  });
});
