import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { designManifestUrlOf } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { designManifestOf, type DesignManifest } from './design.model';

/** The response did not have the manifest's shape; nothing of it is shown. */
export class UnexpectedDesignResponse extends Error {
  constructor(url: string) {
    super(`unexpected response shape from ${url}`);
    this.name = 'UnexpectedDesignResponse';
  }
}

/** Reads a design issue's manifest (#277). Errors propagate as `HttpErrorResponse` or `UnexpectedDesignResponse`. */
@Injectable({ providedIn: 'root' })
export class DesignsApi {
  private readonly http = inject(HttpClient);

  async manifest(slug: string, issue: number): Promise<DesignManifest> {
    const url = designManifestUrlOf(slug, issue);
    const manifest = designManifestOf(await firstValueFrom(this.http.get<unknown>(url)));
    if (manifest === null) {
      throw new UnexpectedDesignResponse(url);
    }
    return manifest;
  }
}
