import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { artifactsSnapshotOf, ArtifactsSnapshot } from './artifact.model';

export function projectArtifactsUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/artifacts`;
}

/** The response did not have the read model's shape; nothing of it is shown. */
export class UnexpectedArtifactsResponse extends Error {
  constructor(url: string) {
    super(`unexpected response shape from ${url}`);
    this.name = 'UnexpectedArtifactsResponse';
  }
}

/** Reads a project's artifacts (#19). Errors propagate as `HttpErrorResponse` or `UnexpectedArtifactsResponse`. */
@Injectable({ providedIn: 'root' })
export class ArtifactsApi {
  private readonly http = inject(HttpClient);

  /** `fresh`: the owner's "Check again" — the Worker skips its read cache. */
  async list(slug: string, options: { readonly fresh?: boolean } = {}): Promise<ArtifactsSnapshot> {
    const url = projectArtifactsUrl(slug);
    const body = await firstValueFrom(
      this.http.get<unknown>(url, options.fresh === true ? { params: { fresh: '1' } } : {}),
    );
    const snapshot = artifactsSnapshotOf(body);
    if (snapshot === null) {
      throw new UnexpectedArtifactsResponse(url);
    }
    return snapshot;
  }
}
