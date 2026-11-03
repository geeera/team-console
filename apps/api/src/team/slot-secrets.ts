import { TEAM_SLOTS, slotSecretNames, type ProjectSlotsDto, type TeamSlot } from '@shared/contracts';
import type { ApiEnv } from '../env';

/** A slot's trigger as the Worker holds it; the token is read only to go into the fire request's header. */
export interface SlotTrigger {
  readonly token: string;
  readonly routineId: string;
}

function secretOf(env: ApiEnv, name: string): string | null {
  // Workers bindings are plain properties of `env`; the names are only known at run time.
  const value: unknown = Reflect.get(env, name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Both secrets of the slot, or `null` when either is missing. */
export function slotTriggerOf(env: ApiEnv, slug: string, slot: TeamSlot): SlotTrigger | null {
  const names = slotSecretNames(slug, slot);
  const token = secretOf(env, names.token);
  const routineId = secretOf(env, names.routine);
  return token === null || routineId === null ? null : { token, routineId };
}

/** Presence only (`ProjectDto.slots`, the setup card): no value leaves this function. */
export function slotsSetupOf(env: ApiEnv, slug: string): ProjectSlotsDto {
  const setup = (slot: TeamSlot) => (slotTriggerOf(env, slug, slot) === null ? 'missing' : 'present');
  return { pm: setup('pm'), dev: setup('dev'), qa: setup('qa') };
}

export function missingSlotsOf(env: ApiEnv, slug: string): TeamSlot[] {
  return TEAM_SLOTS.filter((slot) => slotTriggerOf(env, slug, slot) === null);
}
