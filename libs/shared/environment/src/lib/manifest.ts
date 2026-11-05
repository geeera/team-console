import type { Environment } from '@shared/contracts';

/**
 * The shape of `.product-team/environment-manifest.yml` (#102), the one source of every secret and variable and its
 * guide. `manifest.generated.ts` is that file as data; `manifest.spec.ts` fails when the two differ.
 */

export type ManifestPlace =
  | 'wrangler-secret'
  | 'wrangler-var'
  | 'github-environment-secret'
  | 'github-environment-variable'
  | 'github-repository-secret'
  | 'local-only';

export type ManifestApp = 'api' | 'hooks';

export interface ManifestLocation {
  readonly place: ManifestPlace;
  readonly app?: ManifestApp;
}

export interface ManifestGuide {
  readonly obtain: string | null;
  readonly scopes: string | null;
  readonly rotation: string | null;
  readonly gotchas: string | null;
}

export interface ManifestItem {
  /** A literal name, or a per-project pattern with its placeholders (`ROUTINE_TOKEN_<SLUG>`). */
  readonly name: string;
  readonly pattern?: boolean;
  /** The console works without it; never counted as missing. */
  readonly optional?: boolean;
  readonly kind: 'secret' | 'variable';
  readonly origin: 'owner' | 'generated';
  readonly environments: readonly Environment[];
  readonly locations: readonly ManifestLocation[];
  readonly neededBy: readonly string[];
  readonly purpose: string;
  readonly guide: ManifestGuide;
}

export interface EnvironmentManifest {
  readonly environments: readonly Environment[];
  readonly items: readonly ManifestItem[];
}
