import { LOCAL_JOB_PREFIX } from '../auth/local-job';

/** Test-only: a job the specs send as the local stand-in (#444). */
export interface TestJob {
  readonly role: string;
  readonly jobId?: string;
  readonly items?: readonly number[];
  /** Defaults to the `:slug` of the request path, so a job is of the project it calls unless a case says otherwise. */
  readonly projectSlug?: string;
}

export function base64urlOfText(text: string): string {
  const binary = String.fromCharCode(...new TextEncoder().encode(text));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The stand-in token for a payload, exactly as the plugin's contract suite mints it. */
export function localJobToken(payload: unknown): string {
  return `${LOCAL_JOB_PREFIX}${base64urlOfText(JSON.stringify(payload))}`;
}

function slugOfPath(path: string): string {
  return /^\/api\/v1\/projects\/([^/?]+)/.exec(path)?.[1] ?? 'no-project';
}

/** `Bearer local-job.…` for `job`, its project the path's unless it names one. */
export function localJobHeader(job: TestJob, path: string): string {
  return `Bearer ${localJobToken({
    role: job.role,
    project_slug: job.projectSlug ?? slugOfPath(path),
    job_id: job.jobId ?? 'job-test-1',
    items: job.items ?? [],
  })}`;
}
