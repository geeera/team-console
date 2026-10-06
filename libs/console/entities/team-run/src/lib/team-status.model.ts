import {
  TEAM_SLOTS,
  isSnoozeDto,
  isCalendarDate,
  isTeamSlot,
  type SprintCalendarDto,
  type SprintProgressDto,
  type SprintRefDto,
  type TeamSprintDto,
  type SlotLock,
  type SlotStatusDto,
  type TeamSlot,
  type TeamState,
  type TeamStatusDto,
} from '@shared/contracts';

export function teamStatusUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/team/status`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

function isTeamState(value: unknown): value is TeamState {
  return value === 'running' || value === 'paused-by-owner' || value === 'paused-by-team';
}

function isLock(value: unknown): value is SlotLock | null {
  if (value === null) {
    return true;
  }
  if (!isRecord(value) || !isText(value['since']) || !isText(value['until'])) {
    return false;
  }
  return (
    (value['kind'] === 'started' && isText(value['runId'])) ||
    value['kind'] === 'requested' ||
    value['kind'] === 'unknown'
  );
}

function isLastRun(value: unknown): value is SlotStatusDto['lastRun'] {
  return (
    value === null ||
    (isRecord(value) &&
      isText(value['at']) &&
      (value['state'] === 'finished' || value['state'] === 'failed' || value['state'] === 'unknown'))
  );
}

function isSlotStatus(value: unknown): value is SlotStatusDto {
  return (
    isRecord(value) &&
    isTeamSlot(value['slot']) &&
    (value['setup'] === 'present' || value['setup'] === 'missing') &&
    isRecord(value['secrets']) &&
    isText(value['secrets']['token']) &&
    isText(value['secrets']['routine']) &&
    isLastRun(value['lastRun']) &&
    isLock(value['lock'])
  );
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function isSprintRef(value: unknown): value is SprintRefDto {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value['number']) &&
    isText(value['title']) &&
    isCalendarDate(value['due'])
  );
}

function isTeamSprint(value: unknown): value is TeamSprintDto | null {
  if (value === null) {
    return true;
  }
  if (!isRecord(value) || !isSprintRef(value)) {
    return false;
  }
  const record: Record<string, unknown> = value;
  const freeze = record['freeze'];
  const next = record['next'];
  return (
    isRecord(freeze) &&
    isCalendarDate(freeze['from']) &&
    isCalendarDate(freeze['to']) &&
    (next === null || isSprintRef(next))
  );
}

function isProgress(value: unknown): value is SprintProgressDto | null {
  return (
    value === null ||
    (isRecord(value) && isCount(value['done']) && isCount(value['total']) && value['done'] <= value['total'])
  );
}

function isCalendar(value: unknown): value is SprintCalendarDto | null {
  return (
    value === null ||
    (isRecord(value) &&
      isCalendarDate(value['today']) &&
      isCount(value['freezeDays']) &&
      isText(value['nextTitle']))
  );
}

/** Narrows the Worker's answer; the panel renders nothing it did not check. */
export function isTeamStatusDto(value: unknown): value is TeamStatusDto {
  if (!isRecord(value) || !Array.isArray(value['slots'])) {
    return false;
  }
  const slots = value['slots'];
  return (
    isTeamState(value['state']) &&
    isTextOrNull(value['pausedAt']) &&
    isTextOrNull(value['runLogUrl']) &&
    typeof value['ownerConnected'] === 'boolean' &&
    isText(value['environment']) &&
    isText(value['checkedAt']) &&
    isSnoozeDto(value['snooze']) &&
    isTeamSprint(value['sprint']) &&
    isProgress(value['progress']) &&
    isCalendar(value['calendar']) &&
    isCount(value['pendingRequests']) &&
    slots.length === TEAM_SLOTS.length &&
    slots.every(isSlotStatus) &&
    TEAM_SLOTS.every((slot, index) => (slots[index] as SlotStatusDto).slot === slot)
  );
}

export function isPaused(status: TeamStatusDto): boolean {
  return status.state !== 'running';
}

export function slotOf(status: TeamStatusDto, slot: TeamSlot): SlotStatusDto {
  const found = status.slots.find((candidate) => candidate.slot === slot);
  if (found === undefined) {
    throw new Error(`team status without slot ${slot}`);
  }
  return found;
}

/** Slots whose trigger is not set up, in the panel's order. */
export function missingSlots(status: TeamStatusDto): TeamSlot[] {
  return status.slots.filter((slot) => slot.setup === 'missing').map((slot) => slot.slot);
}

/**
 * The lock a slot has right now on the client's clock: a lock whose `until` passed is gone even before the next
 * status read, so a row never stays off longer than the Worker would refuse.
 */
export function activeLock(slot: SlotStatusDto, nowMs: number): SlotLock | null {
  return slot.lock !== null && Date.parse(slot.lock.until) > nowMs ? slot.lock : null;
}
