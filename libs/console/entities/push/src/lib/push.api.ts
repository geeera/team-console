import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  PushConfigDto,
  PushDeviceDto,
  PushDevicesDto,
  PushSendResultDto,
  PushSubscriptionRequest,
} from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export const PUSH_CONFIG_URL = '/api/v1/push/config';
export const PUSH_SUBSCRIPTIONS_URL = '/api/v1/push/subscriptions';
export const PUSH_TEST_URL = '/api/v1/push/test';

/** The answer did not have the shape #11 promises; nothing of it is used. */
export class UnexpectedPushResponse extends Error {
  constructor(url: string) {
    super(`unexpected response shape from ${url}`);
    this.name = 'UnexpectedPushResponse';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** An uncompressed P-256 point in base64url: 65 bytes are 87 characters without padding. */
export function isPushConfigDto(value: unknown): value is PushConfigDto {
  return (
    isRecord(value) &&
    typeof value['publicKey'] === 'string' &&
    value['publicKey'].length === 87 &&
    BASE64URL.test(value['publicKey'])
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPushSendResultDto(value: unknown): value is PushSendResultDto {
  return isRecord(value) && isCount(value['sent']) && isCount(value['pruned']) && isCount(value['failed']);
}

function isPushDevice(value: unknown): value is PushDeviceDto {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    /^[0-9a-f]{64}$/.test(value['id']) &&
    typeof value['createdAt'] === 'string'
  );
}

export function isPushDevicesDto(value: unknown): value is PushDevicesDto {
  return isRecord(value) && Array.isArray(value['devices']) && value['devices'].every(isPushDevice);
}

/** `PushSubscription.toJSON()` as the Worker accepts it, or null when the browser handed over something else. */
export function subscriptionRequestOf(json: unknown): PushSubscriptionRequest | null {
  if (!isRecord(json) || typeof json['endpoint'] !== 'string' || !isRecord(json['keys'])) {
    return null;
  }
  const { p256dh, auth } = json['keys'];
  if (typeof p256dh !== 'string' || typeof auth !== 'string') {
    return null;
  }
  const expirationTime = json['expirationTime'];
  return {
    endpoint: json['endpoint'],
    expirationTime: typeof expirationTime === 'number' ? expirationTime : null,
    keys: { p256dh, auth },
  };
}

/** Lower-case hex SHA-256 of the endpoint: the device `id` the Worker lists (#11), so this device can find itself. */
export async function deviceIdOf(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * `/api/v1/push/*` (#11). Errors propagate as `HttpErrorResponse` or `UnexpectedPushResponse`; the store decides
 * what each one means for the owner.
 */
@Injectable({ providedIn: 'root' })
export class PushApi {
  private readonly http = inject(HttpClient);

  async publicKey(): Promise<string> {
    const body = await firstValueFrom(this.http.get<unknown>(PUSH_CONFIG_URL));
    if (!isPushConfigDto(body)) {
      throw new UnexpectedPushResponse(PUSH_CONFIG_URL);
    }
    return body.publicKey;
  }

  async devices(): Promise<readonly PushDeviceDto[]> {
    const body = await firstValueFrom(this.http.get<unknown>(PUSH_SUBSCRIPTIONS_URL));
    if (!isPushDevicesDto(body)) {
      throw new UnexpectedPushResponse(PUSH_SUBSCRIPTIONS_URL);
    }
    return body.devices;
  }

  async save(subscription: PushSubscriptionRequest): Promise<void> {
    await firstValueFrom(this.http.put(PUSH_SUBSCRIPTIONS_URL, subscription, { responseType: 'text' }));
  }

  async remove(endpoint: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(PUSH_SUBSCRIPTIONS_URL, { body: { endpoint }, responseType: 'text' }),
    );
  }

  async sendTest(language: 'ru' | 'en'): Promise<PushSendResultDto> {
    const body = await firstValueFrom(this.http.post<unknown>(PUSH_TEST_URL, { language }));
    if (!isPushSendResultDto(body)) {
      throw new UnexpectedPushResponse(PUSH_TEST_URL);
    }
    return body;
  }
}
