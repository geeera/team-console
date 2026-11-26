import { JOB_USER } from '../backends/user';
import type { RunnerToolchain } from '../config/config';
import type { Exec } from '../host/exec';
import type { PathFacts } from '../install/install';

/**
 * The jobs' toolchain (#634 PR 2, architect note section 4, #772, R-ROOT-1/2): `claude`, `git` and `node` found on
 * this Mac and proven usable by the job user. A candidate counts only when `_tcjob` runs `<tool> --version` with an
 * empty environment (the real proof of traversal, the exec bit and, for `/usr/bin/git`, the Command Line Tools) and
 * neither the file nor any directory above it is writable by group or others. A tool under a user's home is refused:
 * the job user cannot reach it, and its owner could swap it. Root only asks; every probe runs as `_tcjob`.
 */

export const TOOLS = ['claude', 'git', 'node'] as const;
export type Tool = (typeof TOOLS)[number];
const REQUIRED: readonly Tool[] = ['claude', 'git'];

const SUDO = '/usr/bin/sudo';
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const USER_HOMES = /^\/(?:Users|home)\/[^/]+\//;
const SHARED_WRITE = 0o022;

export interface ToolchainHost {
  /** Runs as root; used only for `sudo -u _tcjob …`. */
  readonly exec: Exec;
  /** `lstat`: a link is reported as one. */
  stat(path: string): Promise<PathFacts | null>;
  realpath(path: string): Promise<string | null>;
}

export interface AcceptedTool {
  readonly tool: Tool;
  /** As found, never its realpath, so a versioned Homebrew keg is not pinned (#772). */
  readonly path: string;
  /** Set when the file or a directory above it is not root's: the job runs what that user can replace. */
  readonly ownerUid: number | null;
}

export interface ToolProbe {
  readonly accepted: AcceptedTool | null;
  /** Each candidate that was looked at and why it did not count. */
  readonly refused: readonly string[];
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';

/** Where each tool is looked for, in order: Homebrew (Apple silicon, Intel), the system, then the given PATH. */
export function candidatesOf(tool: Tool, searchPath: string, prefix: string | undefined): string[] {
  const fixed = [
    ...(tool === 'node' && prefix !== undefined ? [`${prefix}/node`] : []),
    `/opt/homebrew/bin/${tool}`,
    `/usr/local/bin/${tool}`,
    ...(tool === 'git' ? ['/usr/bin/git'] : []),
  ];
  const fromPath = searchPath
    .split(':')
    .filter((dir) => dir.startsWith('/'))
    .map((dir) => `${dir.replace(/\/+$/, '')}/${tool}`);
  return [...new Set([...fixed, ...fromPath])];
}

/** The first path element (the file or a directory up to `/`) that is writable by others, or whose owner is not root. */
async function walkUp(
  host: ToolchainHost,
  start: string,
): Promise<{ writable: string | null; foreignOwner: number | null }> {
  let foreignOwner: number | null = null;
  for (let path = start; ; path = dirOf(path)) {
    const facts = await host.stat(path);
    if (facts === null) {
      return { writable: path, foreignOwner };
    }
    // A symlink's own mode means nothing; its owner and the directory it sits in do.
    if (facts.kind !== 'symlink' && (facts.mode & SHARED_WRITE) !== 0) {
      return { writable: path, foreignOwner };
    }
    if (facts.uid !== 0) {
      foreignOwner ??= facts.uid;
    }
    if (path === '/') {
      return { writable: null, foreignOwner };
    }
  }
}

/** Whether `_tcjob` can run `path --version` with nothing of root's environment. */
export async function runsAsJobUser(host: ToolchainHost, path: string): Promise<boolean> {
  const { code } = await host.exec(SUDO, [
    '-n',
    '-u',
    JOB_USER,
    '--',
    '/usr/bin/env',
    '-i',
    'HOME=/var/empty',
    `PATH=${[dirOf(path), ...SYSTEM_DIRS].join(':')}`,
    path,
    '--version',
  ]);
  return code === 0;
}

/** Judges one candidate; `null` when it does not exist (not a refusal: most candidates are simply absent). */
export async function judgeCandidate(
  host: ToolchainHost,
  tool: Tool,
  path: string,
): Promise<AcceptedTool | string | null> {
  const real = await host.realpath(path);
  if (real === null) {
    return null;
  }
  if (USER_HOMES.test(path) || USER_HOMES.test(real)) {
    return `${path}: under a user's home, which the job user cannot reach and its owner can change${
      tool === 'claude'
        ? "; install Claude Code system-wide instead (Homebrew: brew install --cask claude-code, or npm install -g @anthropic-ai/claude-code with Homebrew's node)"
        : ''
    }`;
  }
  let ownerUid: number | null = null;
  for (const start of new Set([path, real])) {
    const { writable, foreignOwner } = await walkUp(host, start);
    if (writable !== null) {
      return `${path}: ${writable} is writable by group or others (or could not be inspected)`;
    }
    ownerUid ??= foreignOwner;
  }
  if (!(await runsAsJobUser(host, path))) {
    return `${path}: ${JOB_USER} cannot run it (${tool} --version failed as ${JOB_USER})`;
  }
  return { tool, path, ownerUid };
}

export async function probeTool(
  host: ToolchainHost,
  tool: Tool,
  candidates: readonly string[],
): Promise<ToolProbe> {
  const refused: string[] = [];
  for (const candidate of candidates) {
    const verdict = await judgeCandidate(host, tool, candidate);
    if (verdict === null) {
      continue;
    }
    if (typeof verdict === 'string') {
      refused.push(verdict);
      continue;
    }
    return { accepted: verdict, refused };
  }
  return { accepted: null, refused };
}

export class ToolchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolchainError';
  }
}

export interface DetectedToolchain {
  readonly toolchain: Required<RunnerToolchain>;
  readonly tools: readonly AcceptedTool[];
  /** Lines to print: a missing optional tool, a tool the job runs that another user can replace (R-ROOT-2). */
  readonly warnings: readonly string[];
}

export function ownerWarningOf(tool: AcceptedTool): string | null {
  return tool.ownerUid === null
    ? null
    : `${tool.tool} ${tool.path} belongs to uid ${String(tool.ownerUid)}, not root: that user can replace what jobs run (and read the credential a job hands it); see docs/runbooks/runner.md › user backend`;
}

/** The job PATH: the accepted tools' directories in tool order, then the system's, each once. */
export function jobPathOf(tools: readonly AcceptedTool[]): string {
  return [...new Set([...tools.map((tool) => dirOf(tool.path)), ...SYSTEM_DIRS])].join(':');
}

/** Finds each tool; `claude` and `git` are required, `node` is recorded when found. */
export async function detectToolchain(
  host: ToolchainHost,
  searchPath: string,
  prefix?: string,
): Promise<DetectedToolchain> {
  const tools: AcceptedTool[] = [];
  const warnings: string[] = [];
  const missing: string[] = [];
  for (const tool of TOOLS) {
    const probe = await probeTool(host, tool, candidatesOf(tool, searchPath, prefix));
    if (probe.accepted === null) {
      const why = probe.refused.length === 0 ? 'not found' : probe.refused.join('; ');
      (REQUIRED.includes(tool) ? missing : warnings).push(`${tool}: ${why}`);
      continue;
    }
    tools.push(probe.accepted);
    const warning = ownerWarningOf(probe.accepted);
    if (warning !== null) {
      warnings.push(warning);
    }
  }
  if (missing.length > 0) {
    throw new ToolchainError(`toolchain: ${missing.join('; ')}`);
  }
  const claude = tools.find((tool) => tool.tool === 'claude')?.path ?? 'claude';
  return { toolchain: { path: jobPathOf(tools), claude }, tools, warnings };
}
