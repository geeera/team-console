import { OWNER_ACCOUNT_ID, OWNER_ACCOUNT_SLUG, OWNER_USER_ID, isUlid } from './account';
import { isReservedSlug, isValidSlug } from './project-slug';

describe('isUlid', () => {
  it.each([OWNER_ACCOUNT_ID, OWNER_USER_ID, '01ARZ3NDEKTSV4RRFFQ69G5FAV'])('accepts %s', (id) => {
    expect(isUlid(id)).toBe(true);
  });

  it.each<unknown>([
    '',
    '01ARZ3NDEKTSV4RRFFQ69G5FA',
    '01ARZ3NDEKTSV4RRFFQ69G5FAVX',
    '01arz3ndektsv4rrffq69g5fav',
    '01ARZ3NDEKTSV4RRFFQ69G5FAI',
    7,
  ])('refuses %j', (id) => {
    expect(isUlid(id)).toBe(false);
  });
});

describe('the owner account', () => {
  it('has a valid slug no one else can create', () => {
    expect(isValidSlug(OWNER_ACCOUNT_SLUG)).toBe(true);
    expect(isReservedSlug(OWNER_ACCOUNT_SLUG)).toBe(true);
  });
});
