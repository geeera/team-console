import { fakeKeychain } from '../testing/fake-keychain';
import { KeychainError, keychainAt, parseKeychainPath } from './keychain';

describe('macOS keychain adapter (#585)', () => {
  it('parses the path `security default-keychain` prints', () => {
    expect(parseKeychainPath('    "/Users/me/Library/Keychains/login.keychain-db"\n')).toBe(
      '/Users/me/Library/Keychains/login.keychain-db',
    );
    expect(parseKeychainPath('')).toBeNull();
    expect(parseKeychainPath('security: A default keychain could not be found.')).toBeNull();
  });

  it('pins every call to the keychain file', async () => {
    const fake = fakeKeychain({ defaultKeychain: '/k/login.keychain-db' });
    const keychain = keychainAt('/k/login.keychain-db', fake.exec);
    await keychain.add('runner-key:/a b', 'QUJD', 'label');
    await expect(keychain.read('runner-key:/a b')).resolves.toBe('QUJD');

    const find = fake.calls.find((call) => call.args[0] === 'find-generic-password');
    expect(find?.args.at(-1)).toBe('/k/login.keychain-db');
  });

  it.each(['with"quote', 'with\\backslash', 'with\nnewline', ''])(
    'refuses an account the security CLI cannot take (%j) before running it',
    async (account) => {
      const fake = fakeKeychain({ defaultKeychain: '/k' });
      await expect(keychainAt('/k', fake.exec).read(account)).rejects.toBeInstanceOf(KeychainError);
      await expect(keychainAt('/k', fake.exec).add(account, 'QUJD', 'label')).rejects.toBeInstanceOf(
        KeychainError,
      );
      expect(fake.calls).toEqual([]);
    },
  );

  it('stores only base64, so nothing in a secret can end the -i command line', async () => {
    const fake = fakeKeychain({ defaultKeychain: '/k' });
    await expect(keychainAt('/k', fake.exec).add('a', 'x" "/other', 'label')).rejects.toBeInstanceOf(
      KeychainError,
    );
    expect(fake.calls).toEqual([]);
  });

  it('says a duplicate is a duplicate', async () => {
    const fake = fakeKeychain({ defaultKeychain: '/k' });
    const keychain = keychainAt('/k', fake.exec);
    await keychain.add('a', 'QUJD', 'label');
    await expect(keychain.add('a', 'QUJD', 'label')).rejects.toThrow(/already holds/);
  });
});
