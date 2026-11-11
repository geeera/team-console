import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  isJobDto,
  isJobEventListDto,
  isJobListDto,
  type JobDto,
  type JobEventListDto,
  type JobKind,
  type JobListDto,
} from '@shared/contracts';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import { JOB_CALL_TIMEOUT_MS, jobFailureOf, type JobResult } from './job-failure';

/** `/api/v1/projects/:slug/jobs`: the slug is the route's, encoded; nothing else reaches the path. */
export function projectJobsUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/jobs`;
}

export function jobEventsUrl(slug: string, jobId: string): string {
  return `${projectJobsUrl(slug)}/${encodeURIComponent(jobId)}/events`;
}

/** The newest jobs the view reads: enough for the live ones and the last few that ended. */
export const JOBS_PAGE_LIMIT = 20;
/** Events read per job per refresh; the cursor carries on from the last one seen. */
export const JOB_EVENTS_PAGE_LIMIT = 50;

/** An answer of the wrong shape is not shown: it reads as `error`, like a failed call. */
const MALFORMED = { ok: false, failure: { kind: 'error', slug: null } } as const;

/**
 * The HTTP surface of Run now and the job view (#464) over the routes of #467: the project's newest jobs, a job's
 * events after a cursor, and Run now. Never throws: every call is a `JobResult`, every answer is checked by its guard
 * in `@shared/contracts` before a screen sees it.
 */
@Injectable({ providedIn: 'root' })
export class JobsApi {
  private readonly http = inject(HttpClient);

  list(slug: string, limit = JOBS_PAGE_LIMIT): Promise<JobResult<JobListDto>> {
    const params = new HttpParams().set('limit', String(limit));
    return this.call(this.http.get<unknown>(projectJobsUrl(slug), { params }), isJobListDto);
  }

  events(slug: string, jobId: string, after: number): Promise<JobResult<JobEventListDto>> {
    const params = new HttpParams().set('after', String(after)).set('limit', String(JOB_EVENTS_PAGE_LIMIT));
    return this.call(this.http.get<unknown>(jobEventsUrl(slug, jobId), { params }), isJobEventListDto);
  }

  /** Run now: the kind only; the Worker derives the role, the dedupe key and the defaults. */
  enqueue(slug: string, kind: JobKind): Promise<JobResult<JobDto>> {
    return this.call(this.http.post<unknown>(projectJobsUrl(slug), { kind }), isJobDto);
  }

  private async call<T>(
    request: Observable<unknown>,
    is: (value: unknown) => value is T,
  ): Promise<JobResult<T>> {
    try {
      const body = await firstValueFrom(request.pipe(timeout(JOB_CALL_TIMEOUT_MS)));
      return is(body) ? { ok: true, value: body } : MALFORMED;
    } catch (error: unknown) {
      return { ok: false, failure: jobFailureOf(error) };
    }
  }
}
