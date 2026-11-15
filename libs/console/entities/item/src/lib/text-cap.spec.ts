import { textCapOf } from './text-cap';

describe('textCapOf', () => {
  it('counts code points, so an emoji is one character as the server counts it', () => {
    expect(textCapOf('a😀', 10).length).toBe(2);
  });

  it('shows the counter from 80 % of the cap and says how far over it is', () => {
    expect(textCapOf('x'.repeat(7), 10)).toEqual({ length: 7, max: 10, isCounted: false, overBy: 0 });
    expect(textCapOf('x'.repeat(8), 10)).toMatchObject({ isCounted: true, overBy: 0 });
    expect(textCapOf('x'.repeat(13), 10)).toMatchObject({ isCounted: true, overBy: 3 });
  });
});
