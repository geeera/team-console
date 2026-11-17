import { localNumberOf, localUsdOf } from '@console/shared/i18n';
import type { TeamModel } from '@shared/contracts';

/** A translate function as `TranslocoService.translate` is one; a seam so the wording is a pure, testable function. */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

const MODEL_KEYS: Readonly<Record<TeamModel, string>> = {
  'claude-fable-5-1': 'fable',
  'claude-opus-5-5': 'opus',
  'claude-sonnet-5': 'sonnet',
  'claude-haiku-4-5-20251001': 'haiku',
};

export function modelKeyOf(model: TeamModel): string {
  return MODEL_KEYS[model];
}

export const modelNameOf = (t: Translate, model: TeamModel): string => t(`teamConfig.model.${modelKeyOf(model)}`);

/**
 * The words for a document path in the review table and the error line (UX spec §5 "diff row"): the role's name and
 * the setting ("Developer · model"); the switch of a role is the role's name alone, its value reads on/off.
 */
export function fieldLabelOf(t: Translate, path: string): string {
  const [head, second, third] = path.split('.');
  if (head === 'roles' && second !== undefined && third !== undefined) {
    const role = t(`teamConfig.role.name.${second}`);
    return third === 'enabled' ? role : `${role} · ${t(`teamConfig.field.role.${third}`)}`;
  }
  if (head === 'caps' && second !== undefined && third !== undefined) {
    return `${t(`teamConfig.rules.caps.${second}`)}: ${t(`teamConfig.field.caps.${third}`)}`;
  }
  return t(`teamConfig.field.${path.replace(/\[\d+\]$/, '')}`);
}

/** A value of `path` in words; colour or a struck line never carries the meaning alone (UX spec §6). */
export function valueTextOf(t: Translate, lang: string, path: string, value: unknown): string {
  const key = path.split('.').at(-1) ?? path;
  if (value === null && path === 'budget.monthly_usd') {
    return t('teamConfig.value.noBudget');
  }
  if (typeof value === 'number') {
    return path === 'budget.monthly_usd' ? localUsdOf(value, lang) : localNumberOf(value, lang);
  }
  if (typeof value === 'boolean') {
    return t(key === 'enabled' ? `teamConfig.value.${value ? 'on' : 'off'}` : `teamConfig.value.${value ? 'yes' : 'no'}`);
  }
  if (Array.isArray(value)) {
    return value.map(String).join(', ');
  }
  if (typeof value !== 'string') {
    return t('teamConfig.value.none');
  }
  switch (key) {
    case 'model':
      return value in MODEL_KEYS ? modelNameOf(t, value as TeamModel) : value;
    case 'effort':
      return t(`teamConfig.effort.${value}`);
    case 'preset':
      return t(`teamConfig.preset.${value}`);
    case 'source':
      return t(`teamConfig.value.${value}`);
    case 'qa':
    case 'reviewer':
      return t(`teamConfig.rules.gate.${value}`);
    case 'language':
      return t(`teamConfig.rules.language.${value}`);
    case 'reviewer_context':
      return t(`teamConfig.rules.cost.context.${value}`);
    default:
      return value;
  }
}
