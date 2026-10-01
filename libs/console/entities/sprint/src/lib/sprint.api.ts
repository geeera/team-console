import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { isSprintDto, SprintBoard, sprintBoardOf } from './sprint.model';

export function projectSprintUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/sprint`;
}

/** The response did not have the read model's shape; nothing of it is shown. */
export class UnexpectedSprintResponse extends Error {
  constructor(url: string) {
    super(`unexpected response shape from ${url}`);
    this.name = 'UnexpectedSprintResponse';
  }
}

/** Reads a project's current sprint (#35). Errors propagate as `HttpErrorResponse` or `UnexpectedSprintResponse`. */
@Injectable({ providedIn: 'root' })
export class SprintApi {
  private readonly http = inject(HttpClient);

  async current(slug: string): Promise<SprintBoard> {
    const url = projectSprintUrl(slug);
    const body = await firstValueFrom(this.http.get<unknown>(url));
    if (!isSprintDto(body)) {
      throw new UnexpectedSprintResponse(url);
    }
    return sprintBoardOf(body);
  }
}
