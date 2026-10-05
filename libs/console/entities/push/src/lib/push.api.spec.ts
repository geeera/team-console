import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  deviceIdOf,
  isPushConfigDto,
  isPushSendResultDto,
  PUSH_CONFIG_URL,
  PUSH_SUBSCRIPTIONS_URL,
  PUSH_TEST_URL,
  PushApi,
  subscriptionRequestOf,
  UnexpectedPushResponse,
} from './push.api';

const KEY = `B${'A'.repeat(86)}`;

describe('push read guards', () => {
  it('accepts a 65-byte base64url public key only', () => {
    expect(isPushConfigDto({ publicKey: KEY })).toBe(true);
    expect(isPushConfigDto({ publicKey: KEY.slice(1) })).toBe(false);
    expect(isPushConfigDto({ publicKey: `${KEY.slice(1)}=` })).toBe(false);
    expect(isPushConfigDto({})).toBe(false);
  });

  it('accepts a send result of three counts', () => {
    expect(isPushSendResultDto({ sent: 1, pruned: 0, failed: 0 })).toBe(true);
    expect(isPushSendResultDto({ sent: -1, pruned: 0, failed: 0 })).toBe(false);
    expect(isPushSendResultDto({ sent: 1 })).toBe(false);
  });

  it('turns the browser’s toJSON into the Worker’s request, or null', () => {
    expect(
      subscriptionRequestOf({ endpoint: 'https://x', expirationTime: 5, keys: { p256dh: 'a', auth: 'b' } }),
    ).toEqual({ endpoint: 'https://x', expirationTime: 5, keys: { p256dh: 'a', auth: 'b' } });
    expect(subscriptionRequestOf({ endpoint: 'https://x', keys: {} })).toBeNull();
    expect(subscriptionRequestOf({ endpoint: 'https://x' })).toBeNull();
  });

  it('hashes the endpoint the way the Worker names devices', async () => {
    // SHA-256("abc"), the FIPS 180-2 example.
    await expect(deviceIdOf('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('PushApi', () => {
  let api: PushApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(PushApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the public key and refuses a body of the wrong shape', async () => {
    const good = api.publicKey();
    http.expectOne(PUSH_CONFIG_URL).flush({ publicKey: KEY });
    await expect(good).resolves.toBe(KEY);

    // Only the public key is read from the body; anything next to it is ignored, never kept.
    const extra = api.publicKey();
    http.expectOne(PUSH_CONFIG_URL).flush({ publicKey: KEY, other: 'x' });
    await expect(extra).resolves.toBe(KEY);

    const worse = api.publicKey();
    http.expectOne(PUSH_CONFIG_URL).flush({ key: KEY });
    await expect(worse).rejects.toBeInstanceOf(UnexpectedPushResponse);
  });

  it('stores and removes this device by its endpoint', async () => {
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'a', auth: 'b' } };
    const saving = api.save(subscription);
    const put = http.expectOne(PUSH_SUBSCRIPTIONS_URL);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual(subscription);
    put.flush('', { status: 204, statusText: 'No Content' });
    await saving;

    const removing = api.remove(subscription.endpoint);
    const del = http.expectOne(PUSH_SUBSCRIPTIONS_URL);
    expect(del.request.method).toBe('DELETE');
    expect(del.request.body).toEqual({ endpoint: subscription.endpoint });
    del.flush('', { status: 204, statusText: 'No Content' });
    await removing;
  });

  it('sends the test in the given language', async () => {
    const sending = api.sendTest('en');
    const post = http.expectOne(PUSH_TEST_URL);
    expect(post.request.body).toEqual({ language: 'en' });
    post.flush({ sent: 1, pruned: 0, failed: 0 });
    await expect(sending).resolves.toEqual({ sent: 1, pruned: 0, failed: 0 });
  });
});
