import { isOwnerRequest, type OwnerRequestStatusDto } from '@shared/contracts';
import type { OwnerRequestRecord } from '@worker/db';

/**
 * A recorded request as the console shows it (#219), or `null` for a row whose payload this version cannot read
 * (it then colours nothing). Display only: never an input to a write or an authorisation decision.
 */
export function requestStatusOf(record: OwnerRequestRecord): OwnerRequestStatusDto | null {
  let data: unknown;
  try {
    data = JSON.parse(record.payload);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const { v, ...request } = data as Record<string, unknown>;
  if (v !== 1 || !isOwnerRequest(request)) {
    return null;
  }
  return {
    ...request,
    state: record.result ?? 'pending',
    requestedAt: record.requestedAt,
    url: record.url,
    handledAt: record.handledAt,
  };
}
