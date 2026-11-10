import type { HistoryEntry } from '@console/entities/item';
import type { TranslocoService } from '@console/shared/i18n';
import type { ActorDto, TrackerSprintDto } from '@shared/contracts';

const KNOWN_ROLES: ReadonlySet<string> = new Set(['pm', 'dev', 'architect', 'qa']);

/** How the task screen words names: who wrote a row, a status, a kind, a sprint, a History line. */
export class TaskNames {
  constructor(
    private readonly transloco: TranslocoService,
    private readonly sprints: () => readonly TrackerSprintDto[],
  ) {}

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }

  who(actor: ActorDto): string {
    if (actor.kind === 'owner') {
      return this.t('item.who.owner');
    }
    if (actor.kind === 'system') {
      return this.t('item.who.system');
    }
    if (actor.kind === 'job' && KNOWN_ROLES.has(actor.name)) {
      return this.t(`item.who.${actor.name}`);
    }
    return actor.name;
  }

  status(status: string | null): string {
    return status === null ? this.t('item.none') : this.t(`board.status.${status}`);
  }

  kind(kind: string | null): string {
    return kind === null ? this.t('item.none') : this.t(`board.kind.${kind}`);
  }

  sprint(sprint: number | null): string {
    if (sprint === null) {
      return this.t('item.noSprint');
    }
    return (
      this.sprints().find((entry) => entry.number === sprint)?.title ??
      `Sprint ${String(sprint).padStart(2, '0')}`
    );
  }

  /** The fixed line of an event in the active language; a comment is its own text. */
  line(entry: HistoryEntry): string {
    const line = entry.line;
    switch (line.kind) {
      case 'comment':
        return line.text;
      case 'status':
        return this.t('item.ev.status', { from: this.status(line.from), to: this.status(line.to) });
      case 'kind':
        return this.t('item.ev.kind', { from: this.kind(line.from), to: this.kind(line.to) });
      case 'sprint':
        return this.t('item.ev.sprint', { from: this.sprint(line.from), to: this.sprint(line.to) });
      case 'closed':
        return this.t(line.reason === 'done' ? 'item.ev.closedDone' : 'item.ev.closed');
      case 'decided':
        // A batch approval records its "Одобряю советы команды…" phrase as the decision's text, an individual
        // approve sends none (#470 item 4): shown only when there is one, so the common case stays the plain word.
        if (line.command === 'approve') {
          return line.text === ''
            ? this.t('item.ev.approved')
            : this.t('item.ev.approvedSaid', { said: line.text });
        }
        return line.command === 'reject'
          ? this.t('item.ev.rejected', { why: line.text })
          : this.t('item.ev.decided', { command: line.command ?? '' });
      case 'edited':
        return this.t('item.ev.edit');
      case 'pr-linked':
        return this.t('item.ev.pr');
      default:
        return this.t(`item.ev.${line.kind}`);
    }
  }
}
