import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { PushStore, type PushView } from '@console/entities/push';
import { activeLock, isPaused, missingSlots, TeamStatusStore } from '@console/entities/team-run';
import { SnoozeCommands } from '@console/features/snooze';
import { SprintControls } from '@console/features/sprint-controls';
import { TeamCommands, type CommandOutcome } from '@console/features/team-commands';
import { NetworkStatus } from '@console/shared/api';
import {
  localCalendarDayOf,
  localCalendarRangeOf,
  LocalTimePipe,
  localTimeOf,
  TranslocoPipe,
  TranslocoService,
} from '@console/shared/i18n';
import { Banner, Button, Icon, IconButton, Receipt, StateBlock, type ReceiptTone } from '@console/shared/ui';
import { isInFreeze, isSnoozeActive, TEAM_SLOTS, type SlotStatusDto, type TeamSlot } from '@shared/contracts';
import { CommandsSetup, type SetupLine, type SetupView } from './commands-setup';
import { CommandsStatus, type SprintFacts } from './commands-status';
import { listOf, secretCommandOf, whenOf } from './when';

/** The project the panel commands. */
export interface CommandsProject {
  readonly slug: string;
  readonly name: string;
  readonly repo: string;
}

/** One Run now row as the template draws it. */
interface RunRow {
  readonly slot: TeamSlot;
  /** The line under the title: the last run, the run in progress, the request. */
  readonly line: string;
  readonly lineKind: 'plain' | 'live' | 'clock' | 'unknown';
  /** Why the button is off; `null` when it may be pressed. */
  readonly why: string | null;
  readonly whyIcon: 'key' | 'offline' | 'lock';
  readonly isOff: boolean;
}

/** One row of the Sprint group: a command with its button, or a line that says why there is nothing to do. */
interface SprintRow {
  readonly key: 'demo' | 'next';
  readonly hint: string;
  /** The button's accessible name; `null` when the row has no button (the next sprint exists already). */
  readonly aria: string | null;
}

/** The Notifications row as the template draws it (#221). */
interface SnoozeRow {
  readonly isSnoozed: boolean;
  /** "Snoozed until tomorrow 09:00. Urgent ones still come through." while snoozed. */
  readonly line: string;
  /** Why the button is off; `null` when it may be pressed. */
  readonly why: string | null;
  readonly whyIcon: 'offline' | 'bell-off';
  /** Push is off on this device: the row links to Settings. */
  readonly hasPushFix: boolean;
}

let nextPanelId = 0;
/** Locks and snoozes expire on the client's clock between status reads. */
const CLOCK_TICK_MS = 30_000;
/** Where this device does not get pushes; `checking` and the steps of Turn on are not "off". */
const PUSH_OFF: ReadonlySet<PushView> = new Set<PushView>(['off', 'denied', 'no-push', 'old-ios', 'install', 'in-app']);

/**
 * The Commands panel (#114): the team's state in words, Pause ↔ Resume, and Run now for planning, development and
 * QA, each with the reason it is off or when it last ran; a setup card for slots without a trigger token; the
 * result of the last command as a margin note at the top. The pane on a wide screen, the body of a sheet on the
 * phone (`mode`). Commands stay focusable when off and say why instead of acting.
 */
@Component({
  selector: 'tc-commands-panel',
  imports: [
    Banner,
    Button,
    CommandsSetup,
    CommandsStatus,
    Icon,
    IconButton,
    LocalTimePipe,
    Receipt,
    RouterLink,
    StateBlock,
    TranslocoPipe,
  ],
  templateUrl: './commands-panel.html',
  styleUrl: './commands-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-commands-panel', '[class.tc-commands-panel--sheet]': 'mode() === "sheet"' },
})
export class CommandsPanel {
  private readonly commands = inject(TeamCommands);
  private readonly snoozeCommands = inject(SnoozeCommands);
  private readonly push = inject(PushStore);
  private readonly sprintControls = inject(SprintControls);
  private readonly network = inject(NetworkStatus);
  private readonly transloco = inject(TranslocoService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly store = inject(TeamStatusStore);

  readonly project = input.required<CommandsProject>();
  readonly mode = input<'pane' | 'sheet'>('pane');
  /** The pane's close button (the sheet has its own). */
  readonly closed = output<void>();

  protected readonly id = `tc-cp-${nextPanelId++}`;
  protected readonly slots = TEAM_SLOTS;
  protected readonly result = signal<CommandOutcome | null>(null);
  protected readonly announcement = signal('');
  /** A confirmation is open: a second press waits for it. */
  private readonly isAsking = signal(false);
  private readonly now = signal(Date.now());
  private readonly lang = signal(this.transloco.getActiveLang());

  protected readonly status = computed(() =>
    this.store.slug() === this.project().slug ? this.store.status() : null,
  );
  protected readonly isOffline = computed(() => !this.network.online());
  protected readonly paused = computed(() => {
    const status = this.status();
    return status !== null && isPaused(status);
  });
  /** The status could not be read and nothing is shown: every command is off. */
  protected readonly loadProblem = computed(() => (this.status() === null ? this.store.problem() : null));
  protected readonly hasNoRunLog = computed(() => this.loadProblem()?.slug === 'run-log-missing');

  protected readonly stateText = computed(() => {
    const status = this.status();
    this.lang();
    if (status === null) {
      return '';
    }
    if (status.state === 'paused-by-owner') {
      return status.pausedAt === null
        ? this.t('commands.status.ownerNoTime')
        : this.t('commands.status.owner', { time: localTimeOf(status.pausedAt, this.lang()) });
    }
    return this.t(status.state === 'running' ? 'commands.status.running' : 'commands.status.team');
  });

  /** Why Pause / Resume is off. Run now writes nothing to GitHub, so only these need the owner connection. */
  protected readonly teamWhy = computed<string | null>(() => {
    const status = this.status();
    this.lang();
    if (status === null) {
      return this.t('commands.why.status');
    }
    if (this.isOffline()) {
      return this.t('commands.why.offline');
    }
    return status.ownerConnected ? null : this.t('commands.why.noperm');
  });

  protected readonly sprintFacts = computed<SprintFacts>(() => {
    const status = this.status();
    const lang = this.lang();
    const sprint = status?.sprint ?? null;
    if (status === null || status.calendar === null) {
      return { line: this.t('commands.status.sprintUnknown'), freeze: '', isFreezeNow: false };
    }
    if (sprint === null) {
      return { line: this.t('commands.status.noSprint'), freeze: '', isFreezeNow: false };
    }
    const isFreezeNow = isInFreeze(status.calendar.today, sprint.freeze);
    return {
      line: this.t('commands.status.sprintVal', {
        sprint: sprint.title,
        date: localCalendarDayOf(sprint.due, lang),
      }),
      freeze: isFreezeNow
        ? this.t('commands.status.freezeNow')
        : this.t('commands.status.freeze', {
            range: localCalendarRangeOf(sprint.freeze.from, sprint.freeze.to, lang),
          }),
      isFreezeNow,
    };
  });

  /** Move the demo (with a current sprint) and Start the next sprint, or the line that it exists already. */
  protected readonly sprintRows = computed<SprintRow[]>(() => {
    const status = this.status();
    const lang = this.lang();
    const calendar = status?.calendar ?? null;
    if (status === null || calendar === null) {
      return [];
    }
    const rows: SprintRow[] = [];
    const sprint = status.sprint;
    if (sprint !== null) {
      rows.push({
        key: 'demo',
        hint: this.t('commands.sprint.demoHint', {
          sprint: sprint.title,
          date: localCalendarDayOf(sprint.due, lang),
          range: localCalendarRangeOf(sprint.freeze.from, sprint.freeze.to, lang),
        }),
        aria: this.t('commands.sprint.demoAria', { sprint: sprint.title }),
      });
    }
    if (sprint?.next) {
      rows.push({
        key: 'next',
        hint: this.t('commands.sprint.nextExists', {
          sprint: sprint.next.title,
          date: localCalendarDayOf(sprint.next.due, lang),
        }),
        aria: null,
      });
    } else {
      rows.push({
        key: 'next',
        hint:
          sprint === null
            ? this.t('commands.sprint.nextHintNow', { sprint: calendar.nextTitle })
            : this.t('commands.sprint.nextHint', {
                sprint: calendar.nextTitle,
                date: localCalendarDayOf(sprint.due, lang),
              }),
        aria: this.t('commands.sprint.nextAria', { sprint: calendar.nextTitle }),
      });
    }
    return rows;
  });

  protected readonly rows = computed<RunRow[]>(() => {
    const status = this.status();
    const nowMs = this.now();
    const lang = this.lang();
    return TEAM_SLOTS.map((slot) => {
      const found = status?.slots.find((candidate) => candidate.slot === slot);
      if (status === null || found === undefined) {
        return {
          slot,
          line: '',
          lineKind: 'plain',
          why: this.t('commands.why.status'),
          whyIcon: 'lock',
          isOff: true,
        };
      }
      const { line, lineKind, isLocked } = this.lineOf(found, nowMs, lang);
      let why: string | null = null;
      let whyIcon: RunRow['whyIcon'] = 'lock';
      if (found.setup === 'missing') {
        why = this.t('commands.why.notoken');
        whyIcon = 'key';
      } else if (this.isOffline()) {
        why = this.t('commands.why.offline');
        whyIcon = 'offline';
      } else if (isPaused(status)) {
        why = this.t('commands.why.paused');
      }
      return { slot, line, lineKind, why, whyIcon, isOff: why !== null || isLocked };
    });
  });

  /** Snooze needs push on this device to mean anything here; Turn back on never does (design #29). */
  protected readonly snooze = computed<SnoozeRow | null>(() => {
    const status = this.status();
    const nowMs = this.now();
    this.lang();
    if (status === null) {
      return null;
    }
    const isSnoozed = isSnoozeActive(status.snooze, nowMs);
    const isPushOff = PUSH_OFF.has(this.push.view());
    let line = '';
    if (isSnoozed && status.snooze.snoozed) {
      const until = status.snooze.until;
      line = [
        until === null
          ? this.t('commands.snooze.forever')
          : this.t('commands.snooze.until', { until: this.snoozeCommands.untilText(until) }),
        this.t(status.snooze.allowsUrgent ? 'commands.snooze.urgent' : 'commands.snooze.quiet'),
      ].join('. ');
    }
    if (this.isOffline()) {
      return { isSnoozed, line, why: this.t('commands.why.offline'), whyIcon: 'offline', hasPushFix: false };
    }
    if (!isSnoozed && isPushOff) {
      return { isSnoozed, line, why: this.t('commands.snooze.nopush'), whyIcon: 'bell-off', hasPushFix: true };
    }
    return { isSnoozed, line, why: null, whyIcon: 'offline', hasPushFix: false };
  });

  protected readonly setup = computed<SetupView | null>(() => {
    const status = this.status();
    this.lang();
    if (status === null) {
      return null;
    }
    const missing = missingSlots(status);
    if (missing.length === 0) {
      return null;
    }
    const names = listOf(
      missing.map((slot) => this.t(`commands.slot.${slot}N`)),
      this.lang(),
    );
    const lines: SetupLine[] = status.slots
      .filter((slot) => slot.setup === 'missing')
      .map((slot) => ({
        slot: slot.slot,
        name: this.t(`commands.slot.${slot.slot}`),
        commands: [
          { what: 'id', text: secretCommandOf(slot.secrets.routine, status.environment) },
          { what: 'token', text: secretCommandOf(slot.secrets.token, status.environment) },
        ],
      }));
    return { names, lines };
  });

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), CLOCK_TICK_MS);
    const langs = this.transloco.langChanges$.subscribe((lang) => this.lang.set(lang));
    // Read, never asked for: whether this device gets pushes decides if Snooze is offered (#221).
    void this.push.refresh();
    inject(DestroyRef).onDestroy(() => {
      clearInterval(tick);
      langs.unsubscribe();
    });
  }

  protected toneOf(outcome: CommandOutcome): ReceiptTone {
    return outcome.tone;
  }

  protected refresh(): void {
    if (!this.store.refreshing() && !this.isOffline()) {
      void this.store.refresh();
    }
  }

  protected async pauseOrResume(event: Event): Promise<void> {
    const why = this.teamWhy();
    if (why !== null) {
      this.sayWhy(event, why);
      return;
    }
    const target = { slug: this.project().slug, name: this.project().name };
    await this.act(() => (this.paused() ? this.commands.resume(target) : this.commands.pause(target)));
  }

  /** Sprint commands write as the owner, so they are off for the same reasons as Pause / Resume. */
  protected async sprintCommand(event: Event, row: SprintRow): Promise<void> {
    const why = this.teamWhy();
    if (why !== null) {
      this.sayWhy(event, why);
      return;
    }
    const target = { slug: this.project().slug, name: this.project().name };
    await this.act(() =>
      row.key === 'demo' ? this.sprintControls.moveDemo(target) : this.sprintControls.startNext(target),
    );
  }

  protected async run(event: Event, row: RunRow): Promise<void> {
    if (row.isOff) {
      this.sayWhy(event, [row.why, row.line].filter((text) => text !== null && text !== '').join('. '));
      return;
    }
    await this.act(() =>
      this.commands.run({ slug: this.project().slug, name: this.project().name }, row.slot),
    );
  }

  protected async snoozeOrTurnBackOn(event: Event): Promise<void> {
    const row = this.snooze();
    if (row === null) {
      return;
    }
    if (row.why !== null) {
      this.sayWhy(event, row.why);
      return;
    }
    const target = { slug: this.project().slug, name: this.project().name };
    await this.act(() =>
      row.isSnoozed ? this.snoozeCommands.turnBackOn(target) : this.snoozeCommands.snooze(target),
    );
  }

  private async act(command: () => Promise<CommandOutcome | null>): Promise<void> {
    if (this.isAsking()) {
      return;
    }
    this.isAsking.set(true);
    let outcome: CommandOutcome | null;
    try {
      outcome = await command();
    } finally {
      this.isAsking.set(false);
    }
    if (outcome === null) {
      return;
    }
    this.result.set(outcome);
    this.announce([outcome.verb, outcome.detail].filter((text) => text !== null).join(' '));
    // The note replaces nothing the owner was on; focus goes to it so the outcome is read next.
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('.cp-result')?.focus(), {
      injector: this.injector,
    });
  }

  /** An off command says why instead of acting; it stays focusable so the reason is reachable. */
  private sayWhy(event: Event, why: string): void {
    const label =
      event.currentTarget instanceof HTMLElement ? event.currentTarget.getAttribute('aria-label') : null;
    this.announce(label === null ? why : `${label}: ${why}`);
  }

  protected announce(text: string): void {
    // Cleared first, so the same sentence twice is announced twice.
    this.announcement.set('');
    setTimeout(() => this.announcement.set(text), 30);
  }

  private lineOf(
    slot: SlotStatusDto,
    nowMs: number,
    lang: string,
  ): { line: string; lineKind: RunRow['lineKind']; isLocked: boolean } {
    const lock = activeLock(slot, nowMs);
    if (lock !== null) {
      const params = { time: localTimeOf(lock.since, lang), until: localTimeOf(lock.until, lang) };
      if (lock.kind === 'started') {
        return { line: this.t('commands.row.busy', params), lineKind: 'live', isLocked: true };
      }
      if (lock.kind === 'requested') {
        return { line: this.t('commands.row.requested', params), lineKind: 'live', isLocked: true };
      }
      return { line: this.t('commands.row.unknown', params), lineKind: 'unknown', isLocked: true };
    }
    if (slot.lastRun === null) {
      return { line: this.t('commands.row.never'), lineKind: 'plain', isLocked: false };
    }
    const when = whenOf(slot.lastRun.at, lang, nowMs);
    const key =
      slot.lastRun.state === 'finished'
        ? 'commands.row.last'
        : slot.lastRun.state === 'failed'
          ? 'commands.row.lastFailed'
          : 'commands.row.lastUnknown';
    return { line: this.t(key, { when: this.t(when.key, when.params) }), lineKind: 'plain', isLocked: false };
  }

  protected t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
