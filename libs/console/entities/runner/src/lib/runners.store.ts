import { computed, inject, Injectable, signal } from '@angular/core';
import type { AccountMembershipDto, PendingEnrolmentDto, RunnerDto, RunnerReleaseDto } from '@shared/contracts';
import { liveRunnersOf, managedAccountOf, runnersInDisplayOrder } from './runner.model';
import type { RunnerFailure } from './runner-failure';
import { RunnersApi } from './runners.api';

/**
 * What Settings › Runners shows (#464):
 * - `loading` until the accounts and the runners are read;
 * - `forbidden` when the caller owns no account (a member, or no membership) or the Worker said 403/404 for it;
 * - `error` when a read failed (with `failure`), Try again repeats it;
 * - `ready` with the runners (possibly none — the screen's empty state).
 */
export type RunnersStatus = 'idle' | 'loading' | 'ready' | 'forbidden' | 'error';

/** Why the screen is forbidden: a member of an account, or no account at all. */
export type RunnersForbidden = 'member' | 'none';

/**
 * The account's runners as Settings › Runners shows them: read from the Worker, never assumed, in memory only (a
 * runner list says which machines hold the account's work — not something to leave in `localStorage`).
 */
@Injectable({ providedIn: 'root' })
export class RunnersStore {
  private readonly api = inject(RunnersApi);
  private pending: Promise<void> | null = null;

  readonly status = signal<RunnersStatus>('idle');
  readonly forbidden = signal<RunnersForbidden | null>(null);
  readonly failure = signal<RunnerFailure | null>(null);
  readonly account = signal<AccountMembershipDto | null>(null);
  private readonly list = signal<readonly RunnerDto[]>([]);
  /** Codes that can still enrol a machine (#492), oldest first: the owner can withdraw one. */
  readonly pendingEnrolments = signal<readonly PendingEnrolmentDto[]>([]);
  readonly release = signal<RunnerReleaseDto>({ version: null, minimumVersion: null });

  readonly runners = computed(() => runnersInDisplayOrder(this.list()));
  readonly liveRunners = computed(() => liveRunnersOf(this.list()));
  readonly isEmpty = computed(() => this.status() === 'ready' && this.list().length === 0);

  ready(): Promise<void> {
    return this.status() === 'idle' ? this.load() : (this.pending ?? Promise.resolve());
  }

  load(): Promise<void> {
    if (this.pending !== null) {
      return this.pending;
    }
    this.status.set('loading');
    this.pending = (async () => {
      try {
        await this.read();
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /** A runner the Worker answered after a change (allowed projects, revoke): replaces its row in place. */
  apply(runner: RunnerDto): void {
    this.list.update((runners) => runners.map((row) => (row.id === runner.id ? runner : row)));
  }

  /** A pending code the Worker withdrew: it leaves the list. */
  dropPendingEnrolment(id: string): void {
    this.pendingEnrolments.update((pending) => pending.filter((row) => row.id !== id));
  }

  private async read(): Promise<void> {
    const accounts = await this.api.accounts();
    if (!accounts.ok) {
      this.fail(accounts.failure);
      return;
    }
    const managed = managedAccountOf(accounts.value);
    if (managed.kind !== 'owner') {
      this.account.set(null);
      this.list.set([]);
      this.pendingEnrolments.set([]);
      this.forbidden.set(managed.kind);
      this.status.set('forbidden');
      return;
    }
    this.account.set(managed.account);
    const read = await this.api.list(managed.account.id);
    if (!read.ok) {
      this.fail(read.failure);
      return;
    }
    this.list.set(read.value.runners);
    this.pendingEnrolments.set(read.value.pendingEnrolments);
    this.release.set(read.value.release);
    this.failure.set(null);
    this.forbidden.set(null);
    this.status.set('ready');
  }

  private fail(failure: RunnerFailure): void {
    this.failure.set(failure);
    // A 403 (`account-owner-only`) or a 404 for the account is the same thing to the owner: not theirs to manage.
    if (failure.kind === 'forbidden' || failure.kind === 'not-found') {
      this.list.set([]);
      this.pendingEnrolments.set([]);
      this.forbidden.set('member');
      this.status.set('forbidden');
      return;
    }
    this.status.set('error');
  }
}
