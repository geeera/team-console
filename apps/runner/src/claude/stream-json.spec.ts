import { JOB_KINDS } from '@shared/contracts';
import { promptOf } from './prompts';
import { EVENT_TEXT_MAX, parseStreamLine } from './stream-json';

describe('stream-json parser', () => {
  it('turns assistant text into log events and a tool call into its name only', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Picked #569' },
          { type: 'tool_use', name: 'Bash', input: { command: 'cat ~/.ssh/id_ed25519' } },
        ],
      },
    });
    const parsed = parseStreamLine(line);
    expect(parsed.events).toEqual([
      { level: 'info', kind: 'log', payload: { line: 'Picked #569' } },
      { level: 'info', kind: 'log', payload: { tool: 'Bash' } },
    ]);
    expect(JSON.stringify(parsed.events)).not.toContain('id_ed25519');
    expect(parsed.text).toBe('Picked #569');
  });

  it('reads costUsd, turns and duration from the result event', () => {
    const parsed = parseStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        total_cost_usd: 0.42,
        num_turns: 9,
        duration_ms: 1200,
      }),
    );
    expect(parsed.result).toEqual({
      isError: false,
      subtype: 'success',
      text: 'ok',
      costUsd: 0.42,
      turns: 9,
      durationMs: 1200,
    });
  });

  it('keeps unknown numbers out of the metrics', () => {
    const parsed = parseStreamLine(
      JSON.stringify({ type: 'result', is_error: true, total_cost_usd: 'NaN', num_turns: -1 }),
    );
    expect(parsed.result).toMatchObject({ isError: true, costUsd: null, turns: null, subtype: 'unknown' });
  });

  it('keeps a non-JSON line as a log line and truncates long text', () => {
    expect(parseStreamLine('warning: something').events).toEqual([
      { level: 'info', kind: 'log', payload: { line: 'warning: something' } },
    ]);
    const long = parseStreamLine('x'.repeat(EVENT_TEXT_MAX + 50)).events[0];
    expect(String(long?.payload['line']).length).toBe(EVENT_TEXT_MAX + 1);
  });

  it('maps init to a notice and ignores blank lines and other types', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'x' })).events).toEqual([
      { level: 'info', kind: 'notice', payload: { cli: 'init' } },
    ]);
    expect(parseStreamLine('   ').events).toEqual([]);
    expect(parseStreamLine(JSON.stringify({ type: 'user', message: {} })).events).toEqual([]);
  });
});

describe('prompts', () => {
  it.each(JOB_KINDS)('has a template for %s', (kind) => {
    const prompt = promptOf({
      job: { kind, role: 'orchestrator', items: [569], projectSlug: 'team-console' },
      pluginRoot: '/r/plugin/abc',
    });
    expect(prompt).toContain('team-console');
    expect(prompt).toContain('#569');
    expect(prompt).toContain('/r/plugin/abc');
  });

  it('interpolates item numbers only', () => {
    const prompt = promptOf({
      job: {
        kind: 'slot-dev',
        role: 'orchestrator',
        items: [1, 2.5, -3, 4] as number[],
        projectSlug: 'team-console',
      },
      pluginRoot: '/p',
    });
    expect(prompt).toContain('Items: #1, #4.');
    expect(
      promptOf({ job: { kind: 'slot-pm', role: 'pm', items: [], projectSlug: 'x' }, pluginRoot: '/p' }),
    ).toContain('No items were named.');
  });
});
