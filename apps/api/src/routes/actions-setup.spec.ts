import { parse } from 'yaml';
import {
  isActionsWorkflowDto,
  isProblemDetails,
  problemSlugOf,
  type ActionsWorkflowDto,
} from '@shared/contracts';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import { localEnv, stubGitHub, type StubGitHub } from '../testing/github-kit';
import { jobActor, seedTrackerProject } from '../testing/tracker-kit';
import { localJobHeader } from '../testing/local-job-kit';

// #759 PR 2: `GET …/actions-setup/workflow`, this console's rendering of the runner workflow (architect note §2,
// security note row "Workflow content steered by input").

const ORIGIN = 'https://console.example.com';

interface Call {
  readonly origin?: string;
  readonly configured?: string | undefined;
  readonly headers?: Record<string, string>;
  readonly query?: string;
  readonly logs?: string[];
}

function noGitHub(): StubGitHub {
  return stubGitHub(() => {
    throw new Error('the workflow route must not call GitHub');
  });
}

async function workflowOf(slug: string, stub: StubGitHub, call: Call = {}): Promise<Response> {
  const configured = 'configured' in call ? call.configured : ORIGIN;
  return fetchApi(
    `/api/v1/projects/${slug}/actions-setup/workflow${call.query ?? ''}`,
    localEnv({ CONSOLE_PUBLIC_ORIGIN: configured }),
    {
      origin: call.origin ?? ORIGIN,
      github: new ApiGitHub({ fetch: stub.fetch }),
      ...(call.headers === undefined ? {} : { headers: call.headers }),
      ...(call.logs === undefined ? {} : { logSink: (line: string) => call.logs?.push(line) }),
    },
  );
}

async function slugOf(response: Response): Promise<string | null> {
  const body: unknown = await response.clone().json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

function runStepEnv(text: string): Readonly<Record<string, unknown>> {
  const workflow = parse(text) as {
    jobs: Record<string, { steps: { name?: string; env?: Record<string, unknown> }[] }>;
  };
  return Object.values(workflow.jobs)[0]?.steps.find((step) => step.name === 'Run the job')?.env ?? {};
}

describe('GET /api/v1/projects/:slug/actions-setup/workflow', () => {
  it('answers the rendering with the configured origin and this environment’s audience as literals', async () => {
    const { slug } = await seedTrackerProject();
    const stub = noGitHub();
    const response = await workflowOf(slug, stub);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(isActionsWorkflowDto(body)).toBe(true);
    const dto = body as ActionsWorkflowDto;
    expect(runStepEnv(dto.text)).toMatchObject({
      TC_CONSOLE_URL: ORIGIN,
      TC_CONSOLE_AUDIENCE: 'team-console:local',
    });
    expect(dto.text).not.toContain('__TC_');
    expect(dto.text).not.toContain('${{ vars.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dto.text)));
    expect(dto.sha256).toBe([...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
    expect(dto.text).toContain(`RUNNER_VERSION: ${dto.version}\n`);
    expect(stub.calls).toEqual([]);
  });

  it('takes nothing from the request: a query, Host-like headers and another project give the same bytes', async () => {
    const { slug } = await seedTrackerProject();
    const { slug: other } = await seedTrackerProject();
    const stub = noGitHub();
    const plain = (await (await workflowOf(slug, stub)).json()) as ActionsWorkflowDto;
    const steered = await workflowOf(slug, stub, {
      query: '?origin=https%3A%2F%2Fevil.example.com&audience=team-console%3Aproduction',
      headers: {
        'X-Forwarded-Host': 'evil.example.com',
        'X-Forwarded-Proto': 'http',
        Forwarded: 'host=evil.example.com',
        Origin: 'https://evil.example.com',
      },
    });
    expect(steered.status).toBe(200);
    const steeredBody = (await steered.json()) as ActionsWorkflowDto;
    expect(steeredBody).toEqual(plain);
    expect(steeredBody.text).not.toContain('evil');
    expect(((await (await workflowOf(other, stub)).json()) as ActionsWorkflowDto).sha256).toBe(plain.sha256);
  });

  it('refuses with 503 when the request arrives on another origin than the configured one', async () => {
    const { slug } = await seedTrackerProject();
    const logs: string[] = [];
    const response = await workflowOf(slug, noGitHub(), { origin: 'https://other.example.com', logs });
    expect(response.status).toBe(503);
    expect(await slugOf(response)).toBe('console-origin-misconfigured');
    const text = await response.text();
    expect(text).not.toContain('console.example.com');
    expect(text).not.toContain('other.example.com');
    expect(logs.join('\n')).toContain('console-origin-mismatch');
    expect(logs.join('\n')).not.toContain('example.com');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['with a trailing slash', `${ORIGIN}/`],
    ['plain http', 'http://console.example.com'],
    ['with a quote', `${ORIGIN}'`],
    ['with an expression', `${ORIGIN}\${{ secrets.TC_INFERENCE_API_KEY }}`],
  ])('refuses with 503 when CONSOLE_PUBLIC_ORIGIN is %s', async (_label, configured) => {
    const { slug } = await seedTrackerProject();
    const response = await workflowOf(slug, noGitHub(), { configured });
    expect(response.status).toBe(503);
    expect(await slugOf(response)).toBe('console-origin-misconfigured');
    expect(await response.text()).not.toContain('secrets.');
  });

  it('answers 404 project-not-found for a slug outside the scope, before rendering anything', async () => {
    const response = await workflowOf('no-such-project', noGitHub());
    expect(response.status).toBe(404);
    expect(await slugOf(response)).toBe('project-not-found');
  });

  it('refuses a job of the project with 403 owner-only: the file is the account’s, not a job’s', async () => {
    const { slug } = await seedTrackerProject();
    const path = `/api/v1/projects/${slug}/actions-setup/workflow`;
    const response = await fetchApi(path, localEnv({ CONSOLE_PUBLIC_ORIGIN: ORIGIN }), {
      origin: ORIGIN,
      headers: { Authorization: localJobHeader(jobActor('dev'), path) },
    });
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('owner-only');
  });
});
