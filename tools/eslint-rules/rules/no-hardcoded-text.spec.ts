import { templateParser } from 'angular-eslint';
import { workspaceRoot } from '@nx/devkit';
import { ESLint, Linter } from 'eslint';
import { join } from 'node:path';
import { rules } from '../index.ts';
import { RULE_NAME, rule } from './no-hardcoded-text.ts';

const linter = new Linter({ configType: 'flat' });

/** The rule alone over one template, as angular-eslint parses it. */
function lint(template: string, options: Record<string, unknown> | null = null): string[] {
  return linter
    .verify(
      template,
      [
        {
          files: ['**/*.html'],
          languageOptions: { parser: templateParser },
          plugins: { tc: { rules: { [RULE_NAME]: rule } } },
          rules: { [`tc/${RULE_NAME}`]: options === null ? 'error' : ['error', options] },
        },
      ],
      'probe.component.html',
    )
    .map((message) => message.message);
}

describe('no-hardcoded-text', () => {
  it('is exported to @nx/eslint-plugin under its name', () => {
    expect(rules[RULE_NAME]).toBe(rule);
  });

  describe('passes copy that goes through i18n', () => {
    it.each([
      [`<h1>{{ 'settings.title' | transloco }}</h1>`],
      [`<p>{{ 'settings.projects.offline' | transloco: { time: (loadedAt | localTime) } }}</p>`],
      [`<ng-container *transloco="let t"><p>{{ t('settings.title') }}</p></ng-container>`],
      [`<button [attr.aria-label]="'commands.openAria' | transloco: { name: name }"></button>`],
      [`<tc-state-block [title]="'settings.projects.empty.title' | transloco" />`],
      [`<span>{{ project.displayName }}</span>`],
      [`<span>{{ appInfo.name() }} · {{ appInfo.version() }} · {{ builtAt }}</span>`],
      [`<span>— 3 / 4 —</span>`],
      [`<tc-icon name="chevron-right" size="sm" />`],
      [`<a tc-button variant="primary" data-testid="add-project" type="button"></a>`],
      [`<button [attr.title]="busy ? null : label"></button>`],
      [`<tc-chip [tone]="status === 'ready' ? 'success' : 'warning'"></tc-chip>`],
      [`<p [title]="kind === 'go'"></p>`],
      [`<kbd aria-hidden="true">K</kbd>`],
      [`<code class="path">/p/{{ slug }}</code>`],
      [`@if (busy) { <tc-spinner /> } @else { {{ 'common.done' | transloco }} }`],
    ])('%s', (template) => {
      expect(lint(template)).toEqual([]);
    });
  });

  describe('fails on hard-coded copy', () => {
    it.each([
      [`<h1>Settings</h1>`, 'Hard-coded text "Settings"'],
      [`<h1>Настройки</h1>`, 'Hard-coded text "Настройки"'],
      [`<p>Updated at {{ time }}</p>`, 'Hard-coded text "Updated at"'],
      [`<p>{{ 'Retry' }}</p>`, 'Hard-coded text "Retry"'],
      [`<p>{{ busy ? 'Wait' : ('common.done' | transloco) }}</p>`, 'Hard-coded text "Wait"'],
      [`<p>{{ name ?? 'nobody' }}</p>`, 'Hard-coded text "nobody"'],
      [`@if (busy) { Loading… }`, 'Hard-coded text "Loading…"'],
      [`<button aria-label="Close"></button>`, 'Hard-coded aria-label="Close"'],
      [`<img alt="Avatar" src="a.png" />`, 'Hard-coded alt="Avatar"'],
      [`<input placeholder="Search" />`, 'Hard-coded placeholder="Search"'],
      [`<span title="Open in GitHub"></span>`, 'Hard-coded title="Open in GitHub"'],
      [`<button [attr.aria-label]="'Close'"></button>`, 'Hard-coded aria-label="Close"'],
      [`<tc-state-block [title]="failed ? 'Error' : null" />`, 'Hard-coded title="Error"'],
      [`<tc-field [label]="'Repo: ' + repo" />`, 'Hard-coded label="Repo:"'],
    ])('%s', (template, message) => {
      const messages = lint(template);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(message);
    });
  });

  it('a project may name further user-facing inputs', () => {
    expect(lint(`<tc-banner headline="Paused" />`)).toEqual([]);
    expect(lint(`<tc-banner headline="Paused" />`, { attributes: ['headline'] })).toEqual([
      expect.stringContaining('Hard-coded headline="Paused"'),
    ]);
  });

  it('reports where the text is', () => {
    const [message] = linter.verify(
      `<div>\n  <p>{{ 'a' | transloco }}</p>\n  <p>Oops</p>\n</div>`,
      [
        {
          files: ['**/*.html'],
          languageOptions: { parser: templateParser },
          plugins: { tc: { rules: { [RULE_NAME]: rule } } },
          rules: { [`tc/${RULE_NAME}`]: 'error' },
        },
      ],
      'probe.component.html',
    );
    expect(message?.line).toBe(3);
    expect(message?.column).toBe(6);
  });
});

/**
 * The real wiring: a console project's own ESLint config (root config → `@nx/workspace-no-hardcoded-text`), on an
 * in-memory template and an inline one, so nothing failing is ever written to disk.
 */
describe('no-hardcoded-text in the console projects (real ESLint run)', () => {
  const projectRoot = 'libs/console/pages/settings';
  const ruleId = `@nx/workspace-${RULE_NAME}`;

  async function lintFile(source: string, file: string): Promise<string[]> {
    const eslint = new ESLint({
      cwd: workspaceRoot,
      overrideConfigFile: join(projectRoot, 'eslint.config.mjs'),
    });
    const [result] = await eslint.lintText(source, {
      filePath: join(workspaceRoot, projectRoot, 'src/lib', file),
    });
    return (result?.messages ?? []).filter((message) => message.ruleId === ruleId).map((m) => m.message);
  }

  const component = `
    import { Component } from '@angular/core';
    @Component({ selector: 'tc-probe', template: '<h2>Projects</h2>' })
    export class Probe {}
  `;

  it('fails a .html template with hard-coded text', async () => {
    await expect(lintFile('<h1>Settings</h1>\n', 'probe.page.html')).resolves.toEqual([
      expect.stringContaining('Hard-coded text "Settings"'),
    ]);
  });

  it('fails an inline template with hard-coded text', async () => {
    await expect(lintFile(component, 'probe.page.ts')).resolves.toEqual([
      expect.stringContaining('Hard-coded text "Projects"'),
    ]);
  });

  it('leaves spec fixtures alone', async () => {
    await expect(lintFile(component, 'probe.page.spec.ts')).resolves.toEqual([]);
  });
});
