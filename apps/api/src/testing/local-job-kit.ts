import type { PolicyActor } from '../auth/policy';

/** Test-only: a job the specs send through `trackerPolicyActorOf` (#434, #444). */
export interface TestJob {
  readonly role: string;
  readonly jobId?: string;
  readonly items?: readonly number[];
  /** Defaults to the `:slug` of the request path, so a job is of the project it calls unless a case says otherwise. */
  readonly projectSlug?: string;
}

function slugOfPath(path: string): string {
  return /^\/api\/v1\/projects\/([^/?]+)/.exec(path)?.[1] ?? 'no-project';
}

/** The job actor for `job`, its project the path's unless it names one. */
export function testJobActor(job: TestJob, path: string): PolicyActor {
  return {
    kind: 'job',
    role: job.role,
    projectSlug: job.projectSlug ?? slugOfPath(path),
    jobId: job.jobId ?? 'job-test-1',
    items: job.items ?? [],
  };
}
