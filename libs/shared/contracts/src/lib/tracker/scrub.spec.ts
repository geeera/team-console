import { SCRUB_IDS_MAX, checkScrubItemInput, checkScrubSprintInput } from './scrub';

const failure = (field: string) => ({ ok: false, field, detail: expect.any(String) as unknown });
const EVENTS_ONLY = { events: true, comments: [], asks: [], requests: [] };

describe('checkScrubItemInput', () => {
  it.each([[undefined], [{}]])('masks the history alone for %j, as before #477', (body) => {
    expect(checkScrubItemInput(body)).toEqual({ ok: true, value: EVENTS_ONLY });
  });

  it('masks exactly what a body names', () => {
    expect(checkScrubItemInput({ comments: [3, 1] })).toEqual({
      ok: true,
      value: { events: false, comments: [3, 1], asks: [], requests: [] },
    });
    expect(checkScrubItemInput({ events: true, asks: [2], requests: [7] })).toEqual({
      ok: true,
      value: { events: true, comments: [], asks: [2], requests: [7] },
    });
  });

  it.each([
    [{ events: false }, 'body'],
    [{ events: 'yes' }, 'events'],
    [{ events: 1, comments: [1] }, 'events'],
    [{ comments: [] }, 'comments'],
    [{ comments: 3 }, 'comments'],
    [{ comments: [1, 1] }, 'comments'],
    [{ comments: [0] }, 'comments'],
    [{ comments: [1.5] }, 'comments'],
    [{ comments: ['1'] }, 'comments'],
    [{ comments: Array.from({ length: SCRUB_IDS_MAX + 1 }, (_, index) => index + 1) }, 'comments'],
    [{ asks: [-1] }, 'asks'],
    [{ requests: [null] }, 'requests'],
    [{ all: true }, 'body'],
    [{ comments: [1], body: '[scrubbed]' }, 'body'],
    [[], 'body'],
    [null, 'body'],
    ['{}', 'body'],
  ])('refuses %j (field %s)', (body, field) => {
    expect(checkScrubItemInput(body)).toEqual(failure(field));
  });

  it('takes the most ids a request may name', () => {
    const comments = Array.from({ length: SCRUB_IDS_MAX }, (_, index) => index + 1);
    expect(checkScrubItemInput({ comments })).toMatchObject({ ok: true, value: { comments } });
  });
});

describe('checkScrubSprintInput', () => {
  it('names the fields in a fixed order', () => {
    expect(checkScrubSprintInput({ fields: ['description', 'title'] })).toEqual({
      ok: true,
      value: { fields: ['title', 'description'] },
    });
    expect(checkScrubSprintInput({ fields: ['description'] })).toEqual({
      ok: true,
      value: { fields: ['description'] },
    });
  });

  it.each([
    [{}, 'fields'],
    [{ fields: [] }, 'fields'],
    [{ fields: 'title' }, 'fields'],
    [{ fields: ['title', 'title'] }, 'fields'],
    [{ fields: ['dueOn'] }, 'fields'],
    [{ fields: ['title', 'state'] }, 'fields'],
    [{ fields: ['title'], title: 'New name' }, 'body'],
    [undefined, 'body'],
    [[], 'body'],
  ])('refuses %j (field %s)', (body, field) => {
    expect(checkScrubSprintInput(body)).toEqual(failure(field));
  });
});
