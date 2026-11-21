import { workspaceRoot } from '@nx/devkit';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The release and deploy guard scripts are plain JS outside the Nx graph (they run before `npm ci`), and the specs
 * compare them with `@shared/contracts`, which tooling may not import statically (module boundaries). They are loaded
 * by path at run time instead, typed by the members the specs use.
 */

export interface DeployGuard {
  attestationArgs(asset: string, version: string): string[];
  downloadArgs(version: string, dir: string): string[];
  tarballNamesOf(version: string): string[];
  readonly RUNNER_IMAGE: string;
  imageSubjectOf(digest: string): string;
}

export interface NodeRuntime {
  readonly PLATFORMS: readonly string[];
  parseFingerprints(text: string): string[];
  keyringFingerprints(armored: string): string[];
  parsePin(text: string): { readonly version: string; readonly major: number };
}

export interface ReleaseIdentity {
  readonly RELEASE_PLATFORMS: readonly string[];
  readonly RELEASE_FILES: readonly string[];
  attestationVerifyArgs(asset: string, version: string): string[];
  releaseDownloadArgs(version: string, asset: string, dir: string): string[];
  tarballNameOf(version: string, platform: string): string;
}

const load = async <T>(path: string): Promise<T> => (await import(pathToFileURL(join(workspaceRoot, path)).href)) as T;

export const loadDeployGuard = (): Promise<DeployGuard> => load('tools/deploy-guard/check-runner-release.js');
export const loadNodeRuntime = (): Promise<NodeRuntime> => load('tools/release/node-runtime.mjs');
export const loadReleaseIdentity = (): Promise<ReleaseIdentity> => load('libs/shared/contracts/src/lib/runner-release.ts');

export interface LinuxLayout {
  readonly RUNNER_IMAGE: string;
}

export const loadLinuxLayout = (): Promise<LinuxLayout> => load('libs/shared/contracts/src/lib/runner-linux.ts');
