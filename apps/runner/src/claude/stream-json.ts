import type { JobEventInput } from '@shared/contracts';

/**
 * `claude -p --output-format stream-json --verbose` read line by line into job events and the run's metrics
 * (ADR 0008 decision 9: `costUsd` and `turns` from the `result` event, for H-2 to reconcile). Text is truncated here
 * and redacted by the runner client before it leaves; tool inputs are never forwarded, only the tool's name.
 */

export const EVENT_TEXT_MAX = 2000;

export interface StreamResult {
  readonly isError: boolean;
  readonly subtype: string;
  readonly text: string;
  readonly costUsd: number | null;
  readonly turns: number | null;
  readonly durationMs: number | null;
  /** The result's `usage` token counts; `null` when the CLI gave none of them. */
  readonly usage: StreamUsage | null;
}

/** Each count `null` when absent or not a non-negative whole number. */
export interface StreamUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
}

export interface StreamLine {
  readonly events: readonly JobEventInput[];
  readonly result: StreamResult | null;
  /** Text the usage-limit detector reads (assistant text, an error, the result). */
  readonly text: string;
}

const truncate = (text: string): string =>
  text.length > EVENT_TEXT_MAX ? `${text.slice(0, EVENT_TEXT_MAX)}…` : text;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const countOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

function usageOf(value: unknown): StreamUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  const usage: StreamUsage = {
    inputTokens: countOrNull(value['input_tokens']),
    outputTokens: countOrNull(value['output_tokens']),
    cacheReadInputTokens: countOrNull(value['cache_read_input_tokens']),
    cacheCreationInputTokens: countOrNull(value['cache_creation_input_tokens']),
  };
  return Object.values(usage).every((count) => count === null) ? null : usage;
}

const log = (line: string, level: JobEventInput['level'] = 'info'): JobEventInput => ({
  level,
  kind: 'log',
  payload: { line: truncate(line) },
});

function contentOf(message: unknown): unknown[] {
  return isRecord(message) && Array.isArray(message['content']) ? message['content'] : [];
}

export function parseStreamLine(raw: string): StreamLine {
  const line = raw.trim();
  if (line === '') {
    return { events: [], result: null, text: '' };
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // Not stream-json (a warning the CLI printed): kept as a plain log line.
    return { events: [log(line)], result: null, text: line };
  }
  if (!isRecord(value)) {
    return { events: [log(line)], result: null, text: line };
  }
  switch (value['type']) {
    case 'system':
      return {
        events:
          value['subtype'] === 'init' ? [{ level: 'info', kind: 'notice', payload: { cli: 'init' } }] : [],
        result: null,
        text: '',
      };
    case 'assistant': {
      const events: JobEventInput[] = [];
      const texts: string[] = [];
      for (const part of contentOf(value['message'])) {
        if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
          texts.push(part['text']);
          events.push(log(part['text']));
        } else if (isRecord(part) && part['type'] === 'tool_use' && typeof part['name'] === 'string') {
          events.push({ level: 'info', kind: 'log', payload: { tool: truncate(part['name']) } });
        }
      }
      return { events, result: null, text: texts.join('\n') };
    }
    case 'result': {
      const text = typeof value['result'] === 'string' ? value['result'] : '';
      const result: StreamResult = {
        isError: value['is_error'] === true,
        subtype: typeof value['subtype'] === 'string' ? value['subtype'] : 'unknown',
        text,
        costUsd: numberOrNull(value['total_cost_usd']),
        turns: numberOrNull(value['num_turns']),
        durationMs: numberOrNull(value['duration_ms']),
        usage: usageOf(value['usage']),
      };
      return { events: [], result, text };
    }
    default:
      return { events: [], result: null, text: '' };
  }
}
