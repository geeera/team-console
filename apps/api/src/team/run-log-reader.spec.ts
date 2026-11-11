import { GitHubError, parseRepoName } from '@worker/github';
import { ApiGitHub } from '../github';
import { json, localEnv, stubGitHub } from '../testing/github-kit';
import { readRunLog } from './run-log-reader';

// #487: the comments read must pass `unfollowableNext: 'unexpected'` so an off-host (or unparsable) next link is
// never silently treated as the list's end — it decides `ownerPause`/`pausedSince`/`state`.

const REPO = parseRepoName('geeera/alpha');
const ISSUE_PATH = '/repos/geeera/alpha/issues/22';
const COMMENTS_PATH = `${ISSUE_PATH}/comments`;
const PINNED_YML = 'team:\n  run_log_issue: 22\n';

const issue = (comments: number, labels: readonly string[] = []) =>
  json(200, {
    number: 22,
    html_url: 'https://github.com/geeera/alpha/issues/22',
    user: { login: 'geeera' },
    labels,
    comments,
  });

async function rejection(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a GitHubError');
}

describe('readRunLog (#487: an unfollowable next link while reading the run log)', () => {
  it('answers 502 github-unexpected on an off-host next link, deriving no team state from the partial window', async () => {
    const stub = stubGitHub((call) => {
      if (call.url.pathname === ISSUE_PATH) {
        return issue(1);
      }
      if (call.url.pathname === COMMENTS_PATH) {
        return json(
          200,
          [{ id: 1, body: 'runlog start', created_at: '2026-01-01T00:00:00Z', user: { login: 'geeera' } }],
          {
            link: '<https://evil.example/repos/geeera/alpha/issues/22/comments?page=2>; rel="next"',
          },
        );
      }
      throw new Error(`unexpected call ${call.method} ${call.url.pathname}`);
    });
    const connection = await new ApiGitHub({ fetch: stub.fetch }).connect(localEnv());

    const error = await rejection(readRunLog(connection, REPO, { projectYml: PINNED_YML }));
    expect(error.problem.type).toBe('github-unexpected');
    expect(error.problem.status).toBe(502);

    // One comments request only: the reader never followed the off-host link itself.
    expect(stub.reads().filter((call) => call.url.pathname === COMMENTS_PATH)).toHaveLength(1);
  });

  it('still reads the run log when the next link stays on api.github.com, or there is none', async () => {
    const stub = stubGitHub((call) => {
      if (call.url.pathname === ISSUE_PATH) {
        return issue(1);
      }
      if (call.url.pathname === COMMENTS_PATH) {
        return json(200, [
          { id: 1, body: 'runlog start', created_at: '2026-01-01T00:00:00Z', user: { login: 'geeera' } },
        ]);
      }
      throw new Error(`unexpected call ${call.method} ${call.url.pathname}`);
    });
    const connection = await new ApiGitHub({ fetch: stub.fetch }).connect(localEnv());

    const view = await readRunLog(connection, REPO, { projectYml: PINNED_YML });
    expect(view.issue?.number).toBe(22);
    expect(view.state).toBe('running');
  });
});
