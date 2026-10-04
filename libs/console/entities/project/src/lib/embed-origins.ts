import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { EmbedOriginsDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export function embedOriginsUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/embed-origins`;
}

/** An origin exactly as `URL#origin` serialises it: `https://host[:port]`, nothing more. */
function isOrigin(value: unknown): value is string {
  return typeof value === 'string' && URL.canParse(value) && new URL(value).origin === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEmbedOriginsDto(value: unknown): value is EmbedOriginsDto {
  if (!isRecord(value)) {
    return false;
  }
  const origins = value['embedOrigins'];
  return Array.isArray(origins) && origins.every(isOrigin);
}

/** The response did not have the `EmbedOriginsDto` shape; nothing of it is used. */
export class UnexpectedEmbedOriginsResponse extends Error {
  constructor(url: string) {
    super(`unexpected response shape from ${url}`);
    this.name = 'UnexpectedEmbedOriginsResponse';
  }
}

/**
 * `GET /api/v1/projects/:slug/embed-origins` (#20): the exact origins a project's frames may load. Errors propagate
 * as `HttpErrorResponse` or `UnexpectedEmbedOriginsResponse`; the caller decides what "unknown" means.
 */
@Injectable({ providedIn: 'root' })
export class EmbedOriginsApi {
  private readonly http = inject(HttpClient);

  async origins(slug: string): Promise<readonly string[]> {
    const url = embedOriginsUrl(slug);
    const body = await firstValueFrom(this.http.get<unknown>(url));
    if (!isEmbedOriginsDto(body)) {
      throw new UnexpectedEmbedOriginsResponse(url);
    }
    return body.embedOrigins;
  }
}
