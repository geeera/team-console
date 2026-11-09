import { sha256Hex, webhookSecretsOf } from './signature';

// The signature check itself is `githubWebhooks.verify` of @worker/vcs-github (#463), tested there and end to end in
// routes/github.spec.ts.

const encoder = new TextEncoder();
const bytes = (text: string): ArrayBuffer => encoder.encode(text).buffer as ArrayBuffer;

describe('webhookSecretsOf', () => {
  it('fails closed on a missing or empty current secret', () => {
    expect(webhookSecretsOf(undefined, undefined)).toBeNull();
    expect(webhookSecretsOf('', 'old')).toBeNull();
  });

  it('adds the previous secret only when it is set and not empty', () => {
    expect(webhookSecretsOf('new', undefined)).toEqual(['new']);
    expect(webhookSecretsOf('new', '')).toEqual(['new']);
    expect(webhookSecretsOf('new', 'old')).toEqual(['new', 'old']);
  });
});

describe('sha256Hex', () => {
  it('hashes the raw bytes to lower-case hex', async () => {
    await expect(sha256Hex(bytes('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
