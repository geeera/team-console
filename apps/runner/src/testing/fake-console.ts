import type { JobDto } from '@shared/contracts';
import type { FetchLike } from '../client/runner-client';

/** One request as the fake console saw it. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly redirect: RequestInit['redirect'];
}

export type FakeAnswer = (request: RecordedRequest) => Response;

/** A `fetch` that records every request and answers from `answer`; nothing leaves the process. */
export function fakeConsole(answer: FakeAnswer): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = typeof init.body === 'string' ? init.body : null;
    const recorded: RecordedRequest = {
      url,
      method: init.method ?? 'GET',
      headers,
      body,
      redirect: init.redirect,
    };
    requests.push(recorded);
    return answer(recorded);
  };
  return { fetch, requests };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function problem(status: number, slug: string): Response {
  return json(status, { type: `https://team-console/problems/${slug}`, title: 'x', status });
}

export const RUNNER_ID = '01JC00000000000000000000R1';
export const JOB_ID = '01JC00000000000000000000J1';
export const OTHER_JOB_ID = '01JC00000000000000000000J2';
export const ACCOUNT_ID = '01M6YSNJ000000000000000001';

/** Synthetic secrets built at run time, so no secret-shaped literal sits in the repository (CLAUDE.md, gitleaks). */
export const sentinels = {
  jobToken: `tcj_${'J'.repeat(43)}`,
  enrolmentCode: `tce_${'E'.repeat(43)}`,
  anthropicKey: `sk-ant-api03-${'A'.repeat(40)}`,
  githubToken: `ghs_${'G'.repeat(36)}`,
} as const;

export function jobFixture(overrides: Partial<JobDto> = {}): JobDto {
  return {
    id: JOB_ID,
    projectSlug: 'team-console',
    kind: 'slot-dev',
    role: 'orchestrator',
    state: 'claimed',
    items: [568],
    priority: 0,
    requestedBy: 'owner',
    needsLocal: false,
    dispatch: 'pull',
    runnerId: RUNNER_ID,
    attempt: 1,
    maxMinutes: 90,
    createdAt: '2026-11-13T10:00:00.000Z',
    claimedAt: '2026-11-13T10:00:01.000Z',
    leaseUntil: '2026-11-13T10:05:01.000Z',
    startedAt: null,
    finishedAt: null,
    result: null,
    ...overrides,
  };
}
