import { OWNER_ACCOUNT_ID, isEnrolmentIntentCreatedDto, isEnrolmentIntentDto, isStartEnrolmentResponse, runnerKeyFingerprintOf } from '@shared/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrol } from '../cli/enrol';
import { RunnerClient } from '../client/runner-client';
import { loadRunnerKey, generateRunnerKey } from '../config/runner-key';
import { startLocalStack, type LocalStack } from '../testing/local-stack';

/**
 * #634 PR 3's integration: the api Worker as the e2e local stack runs it (`wrangler dev`, a fresh local D1 with every
 * migration applied, 0037 among them), driven over real HTTP. The owner makes an enrolment intent, a runner key made
 * the way the runner makes one binds to it, the owner approves the fingerprint, the runner collects its enrolment
 * and its JWT is accepted. The second case drives the runner's own side, `enrol --enrolment` as `setup` runs it (PR 2).
 */

const json = { 'Content-Type': 'application/json' };
const owner = { ...json, 'Sec-Fetch-Site': 'same-origin' };

describe('integration: an enrolment intent against the local stack', () => {
  let stack: LocalStack;

  beforeAll(async () => {
    stack = await startLocalStack(95);
  }, 150_000);

  afterAll(async () => {
    await stack.stop();
  }, 30_000);

  it('creates, binds (first bind wins), approves by fingerprint, collects once, and the runner’s JWT is accepted', async () => {
    const { origin } = stack;
    const intents = `${origin}/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/enrolment-intents`;
    const door = (call: 'start' | 'poll', body: unknown): Promise<Response> =>
      fetch(`${origin}/api/v1/runner/enrol/${call}`, { method: 'POST', headers: json, body: JSON.stringify(body) });

    // 1. The owner's wizard: an intent for this account, every project, the `none` backend of fixture environments.
    const createdResponse = await fetch(intents, {
      method: 'POST',
      headers: owner,
      body: JSON.stringify({ name: 'Integration intent', isolation: 'none' }),
    });
    expect(createdResponse.status).toBe(201);
    const created: unknown = await createdResponse.json();
    if (!isEnrolmentIntentCreatedDto(created)) {
      throw new Error('the answer is not an EnrolmentIntentCreatedDto');
    }
    expect(created.command).toBe(`team-console-runner setup --url ${origin} --enrolment ${created.intentId}`);

    // 2. The runner's half: its own key, bound to the intent; the fingerprint is computed on both sides.
    const key = generateRunnerKey();
    const startBody = {
      intentId: created.intentId,
      publicKey: key.publicJwk,
      host: { os: process.platform, arch: process.arch, hostname: 'integration.local' },
      capabilities: { local: true, maxConcurrency: 1 },
      isolation: 'none',
      version: '0.3.0',
    };
    const startResponse = await door('start', startBody);
    expect(startResponse.status).toBe(200);
    const start: unknown = await startResponse.json();
    if (!isStartEnrolmentResponse(start)) {
      throw new Error('the answer is not a StartEnrolmentResponse');
    }
    expect(start.fingerprint).toBe(await runnerKeyFingerprintOf(key.publicJwk));

    // 3. A second machine on the same intent loses: first bind wins.
    const rival = await door('start', { ...startBody, publicKey: generateRunnerKey().publicJwk });
    expect(rival.status).toBe(409);
    expect(await rival.json()).toMatchObject({ type: 'https://team-console/problems/enrolment-intent-bound' });

    // 4. Not approved yet: 202, and a poll right behind it is told to slow down.
    expect((await door('poll', { intentId: created.intentId, pollToken: start.pollToken })).status).toBe(202);
    const early = await door('poll', { intentId: created.intentId, pollToken: start.pollToken });
    expect(early.status).toBe(429);
    expect(await early.json()).toMatchObject({ type: 'https://team-console/problems/slow-down' });

    // 5. The owner sees the request with the fingerprint, and approves exactly that key.
    const shown: unknown = await (await fetch(`${intents}/${created.intentId}`)).json();
    if (!isEnrolmentIntentDto(shown)) {
      throw new Error('the answer is not an EnrolmentIntentDto');
    }
    expect(shown).toMatchObject({ state: 'bound', fingerprint: start.fingerprint, host: { hostname: 'integration.local' } });
    const wrong = await fetch(`${intents}/${created.intentId}/approve`, {
      method: 'POST',
      headers: owner,
      body: JSON.stringify({ fingerprint: start.fingerprint === '0000-0000' ? '0000-0001' : '0000-0000' }),
    });
    expect(wrong.status).toBe(409);
    const approved = await fetch(`${intents}/${created.intentId}/approve`, {
      method: 'POST',
      headers: owner,
      body: JSON.stringify({ fingerprint: shown.fingerprint }),
    });
    expect(approved.status).toBe(200);

    // 6. The runner waits out the interval, as `setup` will, and collects its enrolment once.
    await new Promise<void>((done) => setTimeout(done, start.intervalSeconds * 1000));
    const collected = await door('poll', { intentId: created.intentId, pollToken: start.pollToken });
    expect(collected.status).toBe(200);
    const enrolment = (await collected.json()) as { runnerId: string; audience: string; name: string; projectScope: string };
    expect(enrolment).toMatchObject({ name: 'Integration intent', audience: 'team-console:local', projectScope: 'all' });
    await new Promise<void>((done) => setTimeout(done, start.intervalSeconds * 1000));
    expect((await door('poll', { intentId: created.intentId, pollToken: start.pollToken })).status).toBe(404);

    // 7. The key that never left this process authenticates the enrolled runner.
    const client = new RunnerClient({
      apiUrl: origin,
      runnerId: enrolment.runnerId,
      audience: enrolment.audience,
      privateKey: key.privateKey,
    });
    await expect(client.self()).resolves.toMatchObject({
      runner: { id: enrolment.runnerId, name: 'Integration intent', accountId: OWNER_ACCOUNT_ID, projectScope: 'all' },
    });
    await expect(client.claim()).resolves.toMatchObject({ kind: 'idle' });
  }, 60_000);

  it('enrol --enrolment binds, waits for the owner and writes a home whose key the console accepts', async () => {
    const { origin } = stack;
    const intents = `${origin}/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/enrolment-intents`;
    const created: unknown = await (
      await fetch(intents, { method: 'POST', headers: owner, body: JSON.stringify({ name: 'Setup intent', isolation: 'none' }) })
    ).json();
    if (!isEnrolmentIntentCreatedDto(created)) {
      throw new Error('the answer is not an EnrolmentIntentCreatedDto');
    }
    const home = join(await mkdtemp(join(tmpdir(), 'tcr-intent-it-')), 'home');
    const printed: string[] = [];
    try {
      const enrolled = enrol(
        { url: origin, enrolment: created.intentId, backend: 'none' },
        {
          home,
          fetch: (url, init) => fetch(url, init),
          host: { os: process.platform, arch: process.arch, hostname: 'setup.local' },
          out: (line) => printed.push(line),
        },
      );
      // The owner's wizard: wait for the bind, then approve the fingerprint the terminal printed.
      let shown: unknown = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        shown = await (await fetch(`${intents}/${created.intentId}`)).json();
        if (isEnrolmentIntentDto(shown) && shown.state === 'bound') {
          break;
        }
        await new Promise<void>((done) => setTimeout(done, 200));
      }
      if (!isEnrolmentIntentDto(shown) || shown.fingerprint === null) {
        throw new Error('the intent was never bound');
      }
      expect(printed.at(-1)).toContain(shown.fingerprint);
      const approved = await fetch(`${intents}/${created.intentId}/approve`, {
        method: 'POST',
        headers: owner,
        body: JSON.stringify({ fingerprint: shown.fingerprint }),
      });
      expect(approved.status).toBe(200);
      const config = await enrolled;
      expect(config).toMatchObject({ name: 'Setup intent', apiUrl: origin, projectScope: 'all' });
      const client = new RunnerClient({
        apiUrl: origin,
        runnerId: config.runnerId,
        audience: config.audience,
        privateKey: await loadRunnerKey(home, { platform: 'linux', exec: () => Promise.reject(new Error('no exec')), env: {} }),
      });
      await expect(client.self()).resolves.toMatchObject({ runner: { id: config.runnerId, name: 'Setup intent' } });
    } finally {
      await rm(join(home, '..'), { recursive: true, force: true });
    }
  }, 60_000);
});
