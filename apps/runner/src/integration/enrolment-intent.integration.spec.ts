import { OWNER_ACCOUNT_ID, isEnrolmentIntentCreatedDto, isEnrolmentIntentDto, isStartEnrolmentResponse, runnerKeyFingerprintOf } from '@shared/contracts';
import { RunnerClient } from '../client/runner-client';
import { generateRunnerKey } from '../config/runner-key';
import { startLocalStack, type LocalStack } from '../testing/local-stack';

/**
 * #634 PR 3's integration: the api Worker as the e2e local stack runs it (`wrangler dev`, a fresh local D1 with every
 * migration applied, 0037 among them), driven over real HTTP. The owner makes an enrolment intent, a runner key made
 * the way the runner makes one binds to it, the owner approves the fingerprint, the runner collects its enrolment
 * and its JWT is accepted. The runner's own `setup` verb (PR 2) will replace the hand-made calls here.
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
});
