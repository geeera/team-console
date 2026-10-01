import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { NeedsYouProjectRef } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import {
  isNeedsYouDto,
  isQuestionsDto,
  needsYouViewOf,
  NeedsYouView,
  projectQuestionsOf,
  QuestionItem,
} from './question.model';

export const NEEDS_YOU_ITEMS_URL = '/api/v1/needs-you';

export function projectQuestionsUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/questions`;
}

/** The response did not have the read model's shape; nothing of it is shown. */
export class UnexpectedQuestionsResponse extends Error {
  constructor(url: string) {
    super(`unexpected response shape from ${url}`);
    this.name = 'UnexpectedQuestionsResponse';
  }
}

/** Reads the owner's waiting items (#35). Errors propagate as `HttpErrorResponse` or `UnexpectedQuestionsResponse`. */
@Injectable({ providedIn: 'root' })
export class QuestionsApi {
  private readonly http = inject(HttpClient);

  async needsYou(): Promise<NeedsYouView> {
    const body = await firstValueFrom(this.http.get<unknown>(NEEDS_YOU_ITEMS_URL));
    if (!isNeedsYouDto(body)) {
      throw new UnexpectedQuestionsResponse(NEEDS_YOU_ITEMS_URL);
    }
    return needsYouViewOf(body);
  }

  async projectQuestions(project: NeedsYouProjectRef): Promise<QuestionItem[]> {
    const url = projectQuestionsUrl(project.slug);
    const body = await firstValueFrom(this.http.get<unknown>(url));
    if (!isQuestionsDto(body)) {
      throw new UnexpectedQuestionsResponse(url);
    }
    return projectQuestionsOf(project, body);
  }
}
