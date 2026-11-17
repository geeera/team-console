/**
 * The argv the runner launches the Claude CLI with (#639). Repository-carried config must not run code the agent did
 * not choose to run:
 * - `--strict-mcp-config` with an empty explicit `--mcp-config`: a project `.mcp.json` stdio server otherwise starts in
 *   `-p` mode with no approval (reproduced on CLI 2.1.322). The roles use no MCP server.
 * - `--setting-sources user`: only the job HOME's user settings (and the `--settings` file and managed settings) are
 *   read, so a branch the job checks out mid-run cannot bring project `env`, `enabledPlugins` or command settings in
 *   after the launch-time check. Tradeoff: a repository's own project `permissions` do not apply to the job.
 *
 * Every value is its own argv element and the CLI is spawned without a shell (ADR 0009 T5), so a model id or a turn
 * limit can never become a second flag.
 */

export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

export interface LaunchArgvInput {
  readonly prompt: string;
  readonly model: string;
  readonly settingsPath: string;
  /** The role's `max_turns` from the team configuration; absent leaves the CLI's default. */
  readonly maxTurns?: number | undefined;
}

export function claudeLaunchArgv({ prompt, model, settingsPath, maxTurns }: LaunchArgvInput): string[] {
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
    throw new RangeError('maxTurns must be a positive whole number');
  }
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    ...(maxTurns === undefined ? [] : ['--max-turns', String(maxTurns)]),
    '--settings',
    settingsPath,
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--mcp-config',
    EMPTY_MCP_CONFIG,
  ];
}
