import type { Rule } from 'eslint';
import { RULE_NAME as noHardcodedTextName, rule as noHardcodedText } from './rules/no-hardcoded-text.ts';

/**
 * Workspace lint rules. `@nx/eslint-plugin` loads this file (Node's native type stripping, so erasable TypeScript
 * only and explicit `.ts` imports) and exposes each rule as `@nx/workspace-<name>`.
 */
export const rules: Readonly<Record<string, Rule.RuleModule>> = {
  [noHardcodedTextName]: noHardcodedText,
};
