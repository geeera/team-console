export { TeamCommands } from './lib/team-commands';
export { TeamCommandsClient, runUrl, teamCommandUrl } from './lib/team-commands.client';
// The failure model lives in @console/entities/team-run (#218) so every command feature shares it; re-exported here
// for the consumers that import it from this slice.
export { commandFailureOf, textOf } from '@console/entities/team-run';
export type {
  CommandFailure,
  CommandFailureKind,
  CommandOutcome,
  CommandResult,
  CommandTarget,
} from '@console/entities/team-run';
