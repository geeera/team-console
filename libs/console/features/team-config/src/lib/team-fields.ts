/**
 * Which control on the page a document path lives in: a role's model and effort share the model button, its three
 * limits the limits button; a list member (`gates.code_paths[2]`) is its list. A 422 names the document path, the
 * screen marks and focuses the control.
 */
export function controlPathOf(path: string): string {
  const plain = path.replace(/\[\d+\]$/, '');
  const [head, role, key] = plain.split('.');
  if (head === 'roles' && role !== undefined && key !== undefined) {
    if (key === 'effort') {
      return `roles.${role}.model`;
    }
    if (key.startsWith('max_')) {
      return `roles.${role}.limits`;
    }
  }
  return plain;
}

/** The DOM id of a control by its control path; stable, so the error line and `aria-describedby` agree. */
export function controlIdOf(path: string): string {
  return `tc-team-${path.replace(/[^a-z0-9_-]+/gi, '-')}`;
}

/** The section a control path belongs to, for unfolding it on the phone before focusing. */
export type TeamSectionName = 'preset' | 'access' | 'roles' | 'limits' | 'rules';

export function sectionOf(path: string): TeamSectionName {
  const head = path.split('.')[0];
  switch (head) {
    case 'preset':
      return 'preset';
    case 'access':
      return 'access';
    case 'roles':
      return 'roles';
    case 'budget':
      return 'limits';
    default:
      return 'rules';
  }
}

/** A whole number typed into a bounded field; `null` when it is not one or falls outside. */
export function boundedIntegerOf(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}
