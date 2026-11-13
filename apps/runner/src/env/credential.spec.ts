import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnrolBackend } from '../config/config';
import { LaunchRefusal } from '../jobs/refusal';
import { sentinels } from '../testing/fake-console';
import { jobCredentialOf, parseCredentialConfig, type CredentialConfig } from './credential';

/** ADR 0008 decision 5 (RR11): one credential kind per runner, each on its backends only. */

describe('credential kinds', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tcr-cred-'));
    await mkdir(join(home, 'credentials'), { mode: 0o700 });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('parses the three shapes and refuses anything else', () => {
    expect(parseCredentialConfig({ kind: 'api-key', file: 'credentials/anthropic.key' })).toEqual({
      kind: 'api-key',
      file: 'credentials/anthropic.key',
    });
    expect(parseCredentialConfig({ kind: 'claude-config-dir', path: '/Users/me/.claude' })).not.toBeNull();
    for (const bad of [
      { kind: 'api-key', file: '../keys/runner.key' },
      { kind: 'api-key', file: 'credentials/../x' },
      { kind: 'api-key', file: 'credentials/a', value: 'inline' },
      { kind: 'setup-token', path: '/x' },
      { kind: 'claude-config-dir', path: 'relative' },
      { kind: 'oauth', file: 'credentials/a' },
      'credentials/a',
    ]) {
      expect(parseCredentialConfig(bad)).toBeNull();
    }
  });

  it('reads an api-key file (0600) into ANTHROPIC_API_KEY on the none backend', async () => {
    await writeFile(join(home, 'credentials', 'anthropic.key'), `${sentinels.anthropicKey}\n`, {
      mode: 0o600,
    });
    await expect(
      jobCredentialOf(home, { kind: 'api-key', file: 'credentials/anthropic.key' }, 'none'),
    ).resolves.toEqual({ kind: 'api-key', name: 'ANTHROPIC_API_KEY', value: sentinels.anthropicKey });
  });

  it('is null when no credential is configured', async () => {
    await expect(jobCredentialOf(home, undefined, 'none')).resolves.toBeNull();
  });

  it.each<[CredentialConfig, EnrolBackend]>([
    [{ kind: 'setup-token', file: 'credentials/claude-setup-token' }, 'none'],
    [{ kind: 'setup-token', file: 'credentials/claude-setup-token' }, 'container'],
    [{ kind: 'claude-config-dir', path: '/Users/me/.claude' }, 'none'],
    [{ kind: 'claude-config-dir', path: '/Users/me/.claude' }, 'user'],
  ])('refuses %o on the %s backend', async (credential, backend) => {
    await expect(jobCredentialOf(home, credential, backend)).rejects.toMatchObject({
      reason: 'credential-not-allowed',
    });
  });

  it('refuses a credential file others can read, and never names its value', async () => {
    const file = join(home, 'credentials', 'anthropic.key');
    await writeFile(file, sentinels.anthropicKey, { mode: 0o600 });
    await chmod(file, 0o644);
    const refusal: unknown = await jobCredentialOf(
      home,
      { kind: 'api-key', file: 'credentials/anthropic.key' },
      'none',
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(LaunchRefusal);
    expect(refusal).toMatchObject({ reason: 'credential-unreadable' });
    expect(String((refusal as Error).message)).not.toContain(sentinels.anthropicKey);
  });

  it('refuses a missing or empty credential file', async () => {
    await expect(
      jobCredentialOf(home, { kind: 'api-key', file: 'credentials/missing' }, 'none'),
    ).rejects.toMatchObject({ reason: 'credential-unreadable' });
    await writeFile(join(home, 'credentials', 'empty'), '\n', { mode: 0o600 });
    await expect(
      jobCredentialOf(home, { kind: 'api-key', file: 'credentials/empty' }, 'none'),
    ).rejects.toMatchObject({
      reason: 'credential-unreadable',
    });
  });
});
