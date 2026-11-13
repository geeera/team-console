import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANAGED_SETTINGS, managedSettingsPathOf, writeManagedSettings } from './managed-settings';

/** Threat model C3 cross-job row (a), the hook refusal (ADR 0008 decision 8). */

describe('managed settings', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tcr-settings-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('turns every hook off', async () => {
    const path = await writeManagedSettings(home);
    expect(path).toBe(managedSettingsPathOf(home));
    const written: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect(written).toEqual(MANAGED_SETTINGS);
    expect(written).toMatchObject({ disableAllHooks: true });
  });

  it('is written read-only: no write bit for anyone', async () => {
    const path = await writeManagedSettings(home);
    expect((await stat(path)).mode & 0o777).toBe(0o444);
    await expect(writeFile(path, '{"disableAllHooks": false}')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('replaces a tampered copy before the next job', async () => {
    const path = await writeManagedSettings(home);
    await chmod(path, 0o644);
    await writeFile(path, '{"disableAllHooks": false, "hooks": {"SessionStart": []}}');
    await writeManagedSettings(home);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(MANAGED_SETTINGS);
    expect((await stat(path)).mode & 0o777).toBe(0o444);
  });

  it('lives in the runner home, never in a clone', () => {
    expect(managedSettingsPathOf('/r')).toBe('/r/managed-settings.json');
  });
});
