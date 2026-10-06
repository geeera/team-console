import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { PROBLEM_TYPE_PREFIX } from '@shared/contracts';
import {
  installationEvent,
  installationRepositoriesEvent,
  issueCommentEvent,
  issuesEvent,
  pingEvent,
  pullRequestEvent,
  pushEvent,
  releaseEvent,
  workflowRunEvent,
} from '../testing/payloads';
import {
  RecordingPushSender,
  linkOf,
  subscribeFakeDevice,
  testVapidBindings,
  TEST_WEBHOOK_SECRET,
  cacheEpochOf,
  deliver,
  deliveryCount,
  nextDeliveryId,
  resetDatabase,
  seedProject,
  signatureOf,
} from '../testing/webhook-kit';
import { FakePushService } from '@worker/push/testing';
import { createHooksApp } from '../app';
import { WEBHOOK_BODY_MAX_BYTES } from '../github/body';

const question = (): Record<string, unknown> => issuesEvent('opened', { labels: ['kind:question'] });

async function accessLostAt(slug: string): Promise<string | null | undefined> {
  const row = await env.DB.prepare('SELECT access_lost_at FROM projects WHERE slug = ?1')
    .bind(slug)
    .first<{ access_lost_at: string | null }>();
  return row?.access_lost_at;
}

beforeEach(async () => {
  await resetDatabase();
  await seedProject('storify', 'geeera/storify', { displayName: 'Storify' });
});

describe('POST /hooks/github — secret configuration (threat model row 1)', () => {
  // HMAC-SHA256 with an empty key, computed outside workerd (Web Crypto refuses a zero-length HMAC key).
  const bodySignedWithEmptyKey = '{"action":"opened","repository":{"full_name":"geeera/storify"}}';
  const emptyKeySignature = 'sha256=c1ffcdcc6318f324c51d6026ea06e84268a40134fc635c281f9b36534adbab73';

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])(
    'answers 503 webhook-misconfigured when WEBHOOK_SECRET is %s, even for a body signed with ""',
    async (_n, value) => {
      const { response } = await deliver(bodySignedWithEmptyKey, {
        env: { WEBHOOK_SECRET: value },
        signature: emptyKeySignature,
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        type: `${PROBLEM_TYPE_PREFIX}webhook-misconfigured`,
      });
      expect(await deliveryCount()).toBe(0);
    },
  );

  it('accepts the previous secret during a rotation and only the current one otherwise', async () => {
    const rotating = { WEBHOOK_SECRET: 'new-key', WEBHOOK_SECRET_PREVIOUS: TEST_WEBHOOK_SECRET };
    expect((await deliver(question(), { env: rotating })).response.status).toBe(202);
    const current = await deliver(issuesEvent('edited'), { env: rotating, signWith: 'new-key' });
    await expect(current.response.json()).resolves.toEqual({ status: 'ignored', reason: 'no-notification' });

    const done = { WEBHOOK_SECRET: 'new-key', WEBHOOK_SECRET_PREVIOUS: '' };
    expect((await deliver(issuesEvent('closed'), { env: done })).response.status).toBe(401);
    expect(
      (await deliver(issuesEvent('closed'), { env: { WEBHOOK_SECRET: 'new-key' } })).response.status,
    ).toBe(401);
  });
});

describe('POST /hooks/github — signature (threat model row 2)', () => {
  const raw = JSON.stringify(question());

  it.each([
    ['missing', null],
    ['sha1', 'sha1=0123456789abcdef0123456789abcdef01234567'],
    ['short hex', 'sha256=deadbeef'],
    ['wrong secret', 'computed'],
  ])('answers 401 without detail and writes nothing for a %s signature', async (_name, header) => {
    const signature = header === 'computed' ? await signatureOf(raw, 'someone-else') : header;
    const { response } = await deliver(raw, { signature });

    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}webhook-signature`, status: 401 });
    expect(body).not.toHaveProperty('detail');
    expect(await deliveryCount()).toBe(0);
    expect(await cacheEpochOf('storify')).toBe(0);
  });

  it('answers 401 for the right signature in upper-case hex', async () => {
    const signature = await signatureOf(raw, TEST_WEBHOOK_SECRET);
    const upper = `sha256=${signature.slice(7).toUpperCase()}`;
    expect((await deliver(raw, { signature: upper })).response.status).toBe(401);
  });

  it('answers 401 for a valid signature over a re-serialised body', async () => {
    const signature = await signatureOf(raw, TEST_WEBHOOK_SECRET);
    const reserialised = JSON.stringify(JSON.parse(raw) as unknown, null, 1);
    expect((await deliver(reserialised, { signature })).response.status).toBe(401);
  });

  it('answers ping with pong only after the signature checks out', async () => {
    const signed = await deliver(pingEvent(), { event: 'ping' });
    expect(signed.response.status).toBe(200);
    await expect(signed.response.json()).resolves.toEqual({ status: 'pong' });

    expect((await deliver(pingEvent(), { event: 'ping', signature: null })).response.status).toBe(401);
    expect(await deliveryCount()).toBe(0);
  });
});

describe('POST /hooks/github — size and method (threat model row 7)', () => {
  it('answers 413 to 1 MB + 1 byte sent without Content-Length, before the signature is checked', async () => {
    const oversized = new Uint8Array(WEBHOOK_BODY_MAX_BYTES + 1).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < oversized.length; offset += 64 * 1024) {
          controller.enqueue(oversized.subarray(offset, offset + 64 * 1024));
        }
        controller.close();
      },
    });
    const request = new Request('http://hooks.test/hooks/github', {
      method: 'POST',
      body: stream,
      headers: {
        'x-github-event': 'issues',
        'x-github-delivery': nextDeliveryId(),
        'x-hub-signature-256': 'nonsense',
      },
    });
    expect(request.headers.get('content-length')).toBeNull();
    const ctx = createExecutionContext();
    const response = await createHooksApp({ logSink: () => undefined }).fetch(
      request,
      { ...env, WEBHOOK_SECRET: TEST_WEBHOOK_SECRET },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(413);
    expect(await deliveryCount()).toBe(0);
  });

  it('answers 413 to a declared Content-Length over 1 MB', async () => {
    const { response } = await deliver(question(), {
      headers: { 'content-length': String(WEBHOOK_BODY_MAX_BYTES + 1) },
    });
    expect(response.status).toBe(413);
  });

  it.each(['GET', 'PUT', 'DELETE'])('answers 405 to %s with Allow: POST', async (method) => {
    const { response } = await deliver(question(), { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('POST /hooks/github — replays (threat model row 3)', () => {
  it('answers duplicate for the same delivery id and keeps one row', async () => {
    const deliveryId = nextDeliveryId();
    expect((await deliver(question(), { deliveryId })).response.status).toBe(202);
    const replay = await deliver(issuesEvent('closed'), { deliveryId });

    expect(replay.response.status).toBe(200);
    await expect(replay.response.json()).resolves.toEqual({ status: 'duplicate' });
    expect(await deliveryCount()).toBe(1);
    expect(await cacheEpochOf('storify')).toBe(1);
  });

  it('answers duplicate for the same body under a new delivery id (the id is not signed)', async () => {
    const raw = JSON.stringify(question());
    const sender = new RecordingPushSender();
    expect((await deliver(raw, { pushSender: sender })).response.status).toBe(202);
    const replay = await deliver(raw, { pushSender: sender });

    await expect(replay.response.json()).resolves.toEqual({ status: 'duplicate' });
    expect(sender.messages).toHaveLength(1);
    expect(await cacheEpochOf('storify')).toBe(1);
  });

  it('prunes deliveries older than 7 days on every 100th delivery', async () => {
    await env.DB.prepare(
      `INSERT INTO webhook_deliveries (rowid, delivery_id, event, repo, body_sha256, received_at)
       VALUES (99, 'old', 'issues', 'geeera/storify', 'old-hash', '2026-09-20T00:00:00.000Z')`,
    ).run();
    const now = () => new Date('2026-10-01T12:00:00.000Z');

    const { logs } = await deliver(question(), { now });

    const { results } = await env.DB.prepare('SELECT delivery_id FROM webhook_deliveries').all<{
      delivery_id: string;
    }>();
    expect(results.map((row) => row.delivery_id)).not.toContain('old');
    expect(results).toHaveLength(1);
    expect(logs).toContainEqual(
      expect.objectContaining({ message: 'webhook deliveries pruned', removed: 1 }),
    );
  });
});

describe('POST /hooks/github — routing (ADR 0003 decision 5, threat model row 8)', () => {
  it('matches repository.full_name case-insensitively', async () => {
    const { response } = await deliver(issuesEvent('closed', { repo: 'Geeera/Storify' }));
    expect(response.status).toBe(200);
    expect(await cacheEpochOf('storify')).toBe(1);
  });

  it.each([
    [
      'an unregistered repository',
      () => issuesEvent('opened', { repo: 'geeera/unknown', labels: ['kind:question'] }),
      'unregistered',
    ],
    [
      'an installation mismatch',
      () => issuesEvent('opened', { installationId: 999, labels: ['kind:question'] }),
      'installation-mismatch',
    ],
  ])('ignores %s with 200 and no epoch bump', async (_name, payload, reason) => {
    const sender = new RecordingPushSender();
    const { response } = await deliver(payload(), { pushSender: sender });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ignored', reason });
    expect(await cacheEpochOf('storify')).toBe(0);
    expect(sender.messages).toEqual([]);
  });

  it('ignores an archived project and one without a stored installation', async () => {
    await seedProject('gone', 'geeera/gone', { archivedAt: '2026-10-01T01:00:00Z' });
    await seedProject('legacy', 'geeera/legacy', { installationId: null });

    const archived = await deliver(issuesEvent('closed', { repo: 'geeera/gone' }));
    await expect(archived.response.json()).resolves.toEqual({ status: 'ignored', reason: 'unregistered' });
    const legacy = await deliver(issuesEvent('closed', { repo: 'geeera/legacy' }));
    await expect(legacy.response.json()).resolves.toEqual({
      status: 'ignored',
      reason: 'installation-mismatch',
    });
    expect(await cacheEpochOf('gone')).toBe(0);
    expect(await cacheEpochOf('legacy')).toBe(0);
  });

  it('ignores an unknown event with 200 and writes nothing', async () => {
    const { response } = await deliver({ action: 'created' }, { event: 'star' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ignored', reason: 'unhandled-event' });
    expect(await deliveryCount()).toBe(0);
  });

  it('answers 400 to a signed body that is not a JSON object', async () => {
    expect((await deliver('[1,2]')).response.status).toBe(400);
    expect((await deliver('not json')).response.status).toBe(400);
    expect(await deliveryCount()).toBe(0);
  });
});

describe('POST /hooks/github — cache epoch', () => {
  it.each([
    ['issues', issuesEvent('edited')],
    ['issue_comment', issueCommentEvent({ body: 'ok' })],
    ['pull_request', pullRequestEvent('closed')],
    ['workflow_run', workflowRunEvent({ conclusion: 'success' })],
    ['release', releaseEvent()],
    ['push', pushEvent('refs/heads/main')],
  ])('bumps the epoch for %s', async (event, payload) => {
    expect((await deliver(payload, { event })).response.status).toBeLessThan(300);
    expect(await cacheEpochOf('storify')).toBe(1);
  });

  it('does not bump it for a push to another branch', async () => {
    const { response } = await deliver(pushEvent('refs/heads/dev'), { event: 'push' });
    expect(response.status).toBe(200);
    expect(await cacheEpochOf('storify')).toBe(0);
  });
});

describe('POST /hooks/github — own writes and pushes', () => {
  it('drops a comment the console wrote: no push, still a fresh epoch', async () => {
    await env.DB.prepare(
      `INSERT INTO own_writes (comment_id, repo, issue_number, kind, body_hash, url, created_at)
       VALUES (5550001, 'geeera/storify', 42, 'answer', NULL, 'https://github.com/geeera/storify/issues/42#c', '2026-10-01T00:00:00Z')`,
    ).run();
    const sender = new RecordingPushSender();
    const payload = issueCommentEvent({ commentId: 5550001, body: '<!-- pt-chat:pm -->' });

    const { response } = await deliver(payload, { event: 'issue_comment', pushSender: sender });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ignored', reason: 'own-write' });
    expect(sender.messages).toEqual([]);
    expect(await cacheEpochOf('storify')).toBe(1);
  });

  it('drops a snoozed project’s push (#221) but still bumps the epoch; urgent ones pass by default', async () => {
    await env.DB.prepare(
      "UPDATE projects SET snoozed_at = '2026-10-01T00:00:00.000Z', snoozed_until = NULL WHERE slug = 'storify'",
    ).run();
    const sender = new RecordingPushSender();
    const quiet = await deliver(question(), { pushSender: sender });
    expect(quiet.response.status).toBe(200);
    await expect(quiet.response.json()).resolves.toEqual({ status: 'ignored', reason: 'snoozed' });
    expect(sender.messages).toEqual([]);
    expect(await cacheEpochOf('storify')).toBe(1);

    const release = await deliver(pullRequestEvent('opened', { number: 77 }), {
      event: 'pull_request',
      pushSender: sender,
    });
    expect(release.response.status).toBe(202);
    expect(sender.messages.map(linkOf)).toEqual(['/p/storify/demo']);
  });

  it('mutes urgent ones too when the owner said so, and an expired snooze mutes nothing', async () => {
    const sender = new RecordingPushSender();
    const now = () => new Date('2026-10-05T12:00:00.000Z');
    await env.DB.prepare(
      "UPDATE projects SET snoozed_at = '2026-10-05T11:00:00.000Z', snoozed_until = '2026-10-05T13:00:00.000Z', snooze_allows_urgent = 0 WHERE slug = 'storify'",
    ).run();
    const muted = await deliver(pullRequestEvent('opened'), { event: 'pull_request', pushSender: sender, now });
    await expect(muted.response.json()).resolves.toEqual({ status: 'ignored', reason: 'snoozed' });

    const later = () => new Date('2026-10-05T13:00:00.000Z');
    const back = await deliver(question(), { pushSender: sender, now: later });
    expect(back.response.status).toBe(202);
    expect(sender.messages.map(linkOf)).toEqual(['/p/storify/questions#42']);
  });

  it('queues a mapped push with 202 and the deep link', async () => {
    const sender = new RecordingPushSender();
    const { response, logs } = await deliver(question(), { pushSender: sender });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'queued' });
    expect(sender.messages.map(linkOf)).toEqual(['/p/storify/questions#42']);
    expect(logs).toContainEqual(expect.objectContaining({ message: 'webhook fan-out', sent: 1, pruned: 0 }));
  });

  it('delivers a trusted question to the owner’s device through web push (fake push service)', async () => {
    const service = new FakePushService();
    const endpoint = await subscribeFakeDevice(service);
    const deliveryId = nextDeliveryId();

    const { response, logs, rawLogs } = await deliver(question(), { pushFetch: service.fetch, deliveryId });

    expect(response.status).toBe(202);
    const [delivery] = service.deliveriesTo(endpoint);
    expect(delivery).toMatchObject({ outcome: 'ok', decryptError: null });
    expect(delivery?.payload).toMatchObject({
      notification: {
        title: 'Storify · нужен ваш ответ',
        body: '#42 Pick the onboarding copy',
        lang: 'ru',
        data: {
          onActionClick: {
            default: { operation: 'navigateLastFocusedOrOpen', url: '/p/storify/questions#42' },
          },
        },
      },
    });
    expect(delivery?.vapid?.claims).toMatchObject({ sub: 'https://github.com/geeera/team-console' });
    expect(logs).toContainEqual(
      expect.objectContaining({ message: 'webhook fan-out', sent: 1, pruned: 0, failed: 0, deliveryId }),
    );
    const vapid = await testVapidBindings();
    expect(rawLogs.join('\n')).not.toContain(vapid.VAPID_PRIVATE_KEY);
    expect(rawLogs.join('\n')).not.toContain(endpoint);
  });

  it('still answers 202 when VAPID is not configured, logging the setting names only', async () => {
    const service = new FakePushService();
    const endpoint = await subscribeFakeDevice(service);

    const { response, logs } = await deliver(question(), {
      pushFetch: service.fetch,
      env: { VAPID_PRIVATE_KEY: undefined },
    });

    expect(response.status).toBe(202);
    expect(service.deliveriesTo(endpoint)).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({ message: 'push misconfigured', invalid: ['privateKey'] }),
    );
    expect(logs).toContainEqual(expect.objectContaining({ message: 'webhook fan-out', sent: 0, failed: 1 }));
  });

  it('ignores an outsider’s marker comment with untrusted-author', async () => {
    const sender = new RecordingPushSender();
    const payload = issueCommentEvent({ body: '<!-- pt-chat:pm -->', commentAssociation: 'NONE' });
    const { response } = await deliver(payload, { event: 'issue_comment', pushSender: sender });
    await expect(response.json()).resolves.toEqual({ status: 'ignored', reason: 'untrusted-author' });
    expect(sender.messages).toEqual([]);
  });

  it('still answers 202 when sendToAll throws, and logs {sent, pruned, deliveryId} (row 10)', async () => {
    const deliveryId = nextDeliveryId();
    const sender = new RecordingPushSender(new Error('push service down'));
    const { response, logs } = await deliver(question(), { pushSender: sender, deliveryId });

    expect(response.status).toBe(202);
    expect(logs).toContainEqual(
      expect.objectContaining({ message: 'webhook fan-out', sent: 0, pruned: 0, failed: 1, deliveryId }),
    );
  });

  it('frees the dedupe row when processing fails, so GitHub’s redelivery is processed', async () => {
    const deliveryId = nextDeliveryId();
    await env.DB.prepare('ALTER TABLE projects RENAME COLUMN cache_epoch TO cache_epoch_x').run();
    try {
      const failed = await deliver(issuesEvent('closed'), { deliveryId });
      expect(failed.response.status).toBe(500);
      expect(await deliveryCount()).toBe(0);
    } finally {
      await env.DB.prepare('ALTER TABLE projects RENAME COLUMN cache_epoch_x TO cache_epoch').run();
    }
    expect((await deliver(issuesEvent('closed'), { deliveryId })).response.status).toBe(200);
  });
});

describe('POST /hooks/github — installation events', () => {
  it('installation_repositories.removed marks the project and queues "access lost"; added clears it', async () => {
    const sender = new RecordingPushSender();
    const removed = await deliver(installationRepositoriesEvent('removed', ['Geeera/Storify']), {
      event: 'installation_repositories',
      pushSender: sender,
      now: () => new Date('2026-10-02T08:00:00.000Z'),
    });

    expect(removed.response.status).toBe(202);
    expect(await accessLostAt('storify')).toBe('2026-10-02T08:00:00.000Z');
    expect(sender.messages.map(linkOf)).toEqual(['/settings/projects/storify']);
    expect(sender.messages[0]?.notification.title).toBe('Storify · консоль потеряла доступ к geeera/storify');

    const added = await deliver(installationRepositoriesEvent('added', ['geeera/storify']), {
      event: 'installation_repositories',
    });
    expect(added.response.status).toBe(200);
    await expect(added.response.json()).resolves.toEqual({ status: 'updated' });
    expect(await accessLostAt('storify')).toBeNull();
  });

  it('ignores a removal from another installation or of an unregistered repository', async () => {
    const other = await deliver(installationRepositoriesEvent('removed', ['geeera/storify'], 999), {
      event: 'installation_repositories',
    });
    await expect(other.response.json()).resolves.toEqual({ status: 'ignored', reason: 'unregistered' });
    await deliver(installationRepositoriesEvent('removed', ['geeera/unknown']), {
      event: 'installation_repositories',
    });
    expect(await accessLostAt('storify')).toBeNull();
  });

  it('installation.deleted marks every project of that installation', async () => {
    await seedProject('second', 'geeera/second');
    await seedProject('elsewhere', 'geeera/elsewhere', { installationId: 999 });

    const { response } = await deliver(installationEvent('deleted'), { event: 'installation' });

    expect(response.status).toBe(202);
    expect(await accessLostAt('storify')).not.toBeNull();
    expect(await accessLostAt('second')).not.toBeNull();
    expect(await accessLostAt('elsewhere')).toBeNull();
  });

  it('ignores other installation actions', async () => {
    const { response } = await deliver(installationEvent('created'), { event: 'installation' });
    await expect(response.json()).resolves.toEqual({ status: 'ignored', reason: 'no-notification' });
  });
});

describe('POST /hooks/github — logs (threat model row 9)', () => {
  it('logs a delivery as {deliveryId, event, repo, status} with no payload field and no secret', async () => {
    const deliveryId = nextDeliveryId();
    const payload = issuesEvent('opened', { labels: ['kind:question'], title: 'Sentinel title 7f3a' });
    const { rawLogs, logs } = await deliver(payload, { deliveryId, pushSender: new RecordingPushSender() });

    const line = logs.find((entry) => entry['message'] === 'webhook delivery');
    expect(line).toBeDefined();
    const { level, message, service, requestId, ts, ...fields } = line ?? {};
    expect({ level, message, service, requestId: typeof requestId, ts: typeof ts }).toEqual({
      level: 'info',
      message: 'webhook delivery',
      service: 'hooks',
      requestId: 'string',
      ts: 'string',
    });
    expect(fields).toEqual({ deliveryId, event: 'issues', repo: 'geeera/storify', status: 'queued' });

    const all = rawLogs.join('\n');
    expect(all).not.toContain('Sentinel title 7f3a');
    expect(all).not.toContain(TEST_WEBHOOK_SECRET);
    expect(all).not.toContain('sha256=');
  });

  it('logs a rejected signature without the secret or the header', async () => {
    const { rawLogs } = await deliver(question(), { signature: `sha256=${'0'.repeat(64)}` });
    const all = rawLogs.join('\n');
    expect(all).toContain('rejected:signature');
    expect(all).not.toContain(TEST_WEBHOOK_SECRET);
    expect(all).not.toContain('0'.repeat(64));
  });
});
