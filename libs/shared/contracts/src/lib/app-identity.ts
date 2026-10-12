import type { Environment } from './health';

/**
 * How the installed app names and draws itself per environment (#237). dev, stage and production are separate
 * origins and so separate installs; the name, icon, window title and push titles keep them apart. Production stays
 * exactly as it was.
 */

/** The product name: the same in ru and en. */
export const APP_NAME = 'Team Console';

const PRODUCTION_SHORT_NAME = 'Console';
const SHORT_PREFIX = 'TC';

const ENVIRONMENT_LABELS: Readonly<Record<Environment, string | null>> = {
  local: 'Local',
  dev: 'Dev',
  stage: 'Stage',
  production: null,
};

/** `Dev`, `Stage` or `Local`; `null` in production, which carries no mark. */
export function environmentLabelOf(environment: Environment): string | null {
  return ENVIRONMENT_LABELS[environment];
}

/** `Team Console Dev` — the manifest `name`, the window title and the iOS Home Screen title. */
export function appNameOf(environment: Environment): string {
  const label = environmentLabelOf(environment);
  return label === null ? APP_NAME : `${APP_NAME} ${label}`;
}

/** `TC Dev` — the manifest `short_name`, shown under the icon where space is tight. */
export function appShortNameOf(environment: Environment): string {
  const label = environmentLabelOf(environment);
  return label === null ? PRODUCTION_SHORT_NAME : `${SHORT_PREFIX} ${label}`;
}

/** Where that environment's icon set lives among the console's static files (`apps/console/public/icons/<env>`). */
export function appIconDirOf(environment: Environment): string {
  return `/icons/${environment}`;
}
