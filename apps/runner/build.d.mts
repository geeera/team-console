import type { BuildOptions } from 'esbuild';

export declare const workspaceRoot: string;
export declare const outFile: string;
export declare function versionDefine(env: Readonly<Record<string, string | undefined>>): Record<string, string>;
export declare function bundleOptions(env?: Readonly<Record<string, string | undefined>>): BuildOptions;
