import { DOCUMENT } from '@angular/common';
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
import { activeLock, isPaused, missingSlots, TeamStatusStore } from '@console/entities/team-run';
import { TeamCommands, type CommandOutcome } from '@console/features/team-commands';
import { NetworkStatus } from '@console/shared/api';
import { LocalTimePipe, localTimeOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Banner, Button, Icon, IconButton, Receipt, StateBlock, type ReceiptTone } from '@console/shared/ui';
import { TEAM_SLOTS, type SlotStatusDto, type TeamSlot } from '@shared/contracts';
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

interface SetupLine {
  readonly slot: TeamSlot;
  readonly name: string;
  readonly commands: readonly { readonly what: 'id' | 'token'; readonly text: string }[];
}

let nextPanelId = 0;
/** Locks expire on the client's clock between status reads. */
const CLOCK_TICK_MS = 30_000;

/**
 * The Commands panel (#114): the team's state in words, Pause ↔ Resume, and Run now for planning, development and
 * QA, each with the reason it is off or when it last ran; a setup card for slots without a trigger token; the
 * result of the last command as a margin note at the top. The pane on a wide screen, the body of a sheet on the
 * phone (`mode`). Commands stay focusable when off and say why instead of acting.
 */
@Component({
  selector: 'tc-commands-panel',
  imports: [Banner, Button, Icon, IconButton, LocalTimePipe, Receipt, RouterLink, StateBlock, TranslocoPipe],
  templateUrl: './commands-panel.html',
  styleUrl: './commands-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-commands-panel', '[class.tc-commands-panel--sheet]': 'mode() === "sheet"' },
})
export class CommandsPanel {
  private readonly commands = inject(TeamCommands);
  private readonly network = inject(NetworkStatus);
  private readonly transloco = inject(TranslocoService);
  private readonly document = inject(DOCUMENT);
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
  protected readonly isHowOpen = signal(false);
  protected readonly copied = signal<string | null>(null);
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

  protected readonly setup = computed(() => {
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

  protected async run(event: Event, row: RunRow): Promise<void> {
    if (row.isOff) {
      this.sayWhy(event, [row.why, row.line].filter((text) => text !== null && text !== '').join('. '));
      return;
    }
    await this.act(() =>
      this.commands.run({ slug: this.project().slug, name: this.project().name }, row.slot),
    );
  }

  protected async copy(text: string, event: Event): Promise<void> {
    const button = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    try {
      await this.document.defaultView?.navigator.clipboard.writeText(text);
    } catch (error: unknown) {
      // No clipboard (an insecure origin, a denied permission): select the line so it can be copied by hand.
      console.warn('clipboard unavailable; the command is selected instead', error);
      const code = button?.parentElement?.querySelector('code');
      const selection = this.document.getSelection();
      if (code !== null && code !== undefined && selection !== null) {
        selection.selectAllChildren(code);
      }
      return;
    }
    this.copied.set(text);
    this.announce(this.t('commands.setup.copied'));
    setTimeout(() => {
      if (this.copied() === text) {
        this.copied.set(null);
      }
    }, 2400);
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

  private announce(text: string): void {
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
