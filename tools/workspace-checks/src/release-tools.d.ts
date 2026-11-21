// The release and deploy guard scripts are plain JS (they run before `npm ci`) with no declaration files; these are
// the members the specs call. A wildcard, because TS honours an ambient module for a relative path only that way.
declare module '*/deploy-guard/check-runner-release.js' {
  export function attestationArgs(asset: string, version: string): string[];
  export function downloadArgs(version: string, dir: string): string[];
  export function tarballNamesOf(version: string): string[];
}

declare module '*/release/node-runtime.mjs' {
  export const PLATFORMS: readonly string[];
  export function parseFingerprints(text: string): string[];
  export function keyringFingerprints(armored: string): string[];
  export function parsePin(text: string): { readonly version: string; readonly major: number };
}
