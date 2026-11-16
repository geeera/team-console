import type { IsolationBackend } from '../backends/backend';
import { sentinels } from '../testing/fake-console';
import { makeRunnerHome, recordingConsole, runnerConfigFor } from '../testing/job-fixture';
import { runLoop } from './loop';

/** #592 item 4: the loop's own log lines pass the redactor, as the job's do. */

const preflightOnly = { preflight: async () => undefined } as unknown as IsolationBackend;

describe('the job loop log', () => {
  let fixture: Awaited<ReturnType<typeof makeRunnerHome>>;

  beforeEach(async () => {
    fixture = await makeRunnerHome();
  });

  afterEach(async () => {
    await fixture.done();
  });

  it('redacts a secret quoted in a claim error', async () => {
    const logs: string[] = [];
    const shutdown = new AbortController();
    const client = Object.assign(recordingConsole(), {
      claim: async () => {
        shutdown.abort();
        throw new Error(`claim: 401 bad bearer ${sentinels.githubToken} / ${sentinels.anthropicKey}`);
      },
    });
    const end = await runLoop('loop', {
      home: fixture.home,
      config: runnerConfigFor(fixture.repo),
      client,
      backend: preflightOnly,
      sourceEnv: {},
      log: (line) => logs.push(line),
      now: () => new Date(),
      shutdown: shutdown.signal,
      sleep: async () => undefined,
    });

    expect(end).toBe('shutdown');
    const claimLine = logs.find((line) => line.startsWith('claim failed: '));
    expect(claimLine).toContain('[redacted:');
    expect(claimLine).not.toContain(sentinels.githubToken);
    expect(claimLine).not.toContain(sentinels.anthropicKey);
  });
});
