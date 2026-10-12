import { inject, Injectable } from '@angular/core';
import {
  TeamStatusStore,
  textOf,
  type CommandFailure,
  type CommandOutcome,
  type CommandTarget,
} from '@console/entities/team-run';
import { localDayOf, localTimeOf, TranslocoService } from '@console/shared/i18n';
import { Sheet } from '@console/shared/ui';
import type { IssueRequestDto, OwnerRequest, TeamStatusDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { RequestChangeClient } from './request-change.client';
import {
  RequestFormDialog,
  type RequestFormData,
  type RequestFormResult,
  type RequestSendAnswer,
} from './request-form-dialog';
import { RequestPickerDialog, type RequestPickerData } from './request-picker-dialog';

/** When `Retry-After` is missing on GitHub's rate limit. */
const DEFAULT_RETRY_AFTER_S = 60;

/**
 * "Ask the PM about an issue" (#219, ADR 0005): the picker (unless the issue is known), then the form; one comment
 * on the owner's token per send, never a sprint, label or order change. The outcome is the panel's result note;
 * the team status is read again afterwards so the pending count is live.
 */
@Injectable({ providedIn: 'root' })
export class RequestChange {
  private readonly sheet = inject(Sheet);
  private readonly client = inject(RequestChangeClient);
  private readonly store = inject(TeamStatusStore);
  private readonly transloco = inject(TranslocoService);
  /** The clock of the messages; a seam for specs. */
  now: () => number = () => Date.now();

  /** The outcome, or `null` when the owner backed out. */
  async ask(target: CommandTarget, number?: number): Promise<CommandOutcome | null> {
    const status = await this.statusOf(target.slug);
    if (status !== null && !status.ownerConnected) {
      return this.outcome('warning', this.t('commands.sprint.noperm'));
    }
    const picked = number ?? (await this.pick(target.slug));
    if (picked === undefined) {
      return null;
    }
    const result = await this.form(target.slug, picked);
    if (result === undefined) {
      return null;
    }
    void this.store.refresh();
    const isPaused = status !== null && status.state !== 'running';
    return this.outcome(
      'positive',
      this.t('commands.request.done', { n: picked }),
      this.t(
        result.response.replayed
          ? 'commands.request.replayed'
          : isPaused
            ? 'commands.request.donePaused'
            : 'commands.request.doneDetail',
      ),
    );
  }

  /** "move to Sprint 05", "move up the queue" in the active language. */
  describe(request: OwnerRequest, issue: IssueRequestDto): string {
    if (request.kind === 'priority') {
      return this.t(request.direction === 'up' ? 'commands.request.dUp' : 'commands.request.dDown');
    }
    if (request.target === 'backlog') {
      return this.t('commands.request.dBacklog');
    }
    const sprint = request.target === 'current' ? issue.current : issue.next;
    return sprint === null
      ? this.t(request.target === 'current' ? 'commands.request.dCurrent' : 'commands.request.dNext')
      : this.t('commands.request.dSprint', { sprint: sprint.title });
  }

  private async pick(slug: string): Promise<number | undefined> {
    const data: RequestPickerData = {
      load: async () => {
        const result = await this.client.issues(slug);
        return result.ok ? result.value.items : null;
      },
    };
    const ref = this.sheet.open<number, RequestPickerData>(RequestPickerDialog, {
      title: this.t('commands.pick.title'),
      data,
      autoFocus: 'input[type=search]',
    });
    return firstValueFrom(ref.closed);
  }

  private async form(slug: string, number: number): Promise<RequestFormResult | undefined> {
    // The title needs the issue: it is read once here, and the dialog re-reads it on Retry or a conflict.
    const load = async (): Promise<IssueRequestDto | null> => {
      const result = await this.client.issue(slug, number);
      return result.ok ? result.value : null;
    };
    const first = await load();
    let isFirstLoad = true;
    const data: RequestFormData = {
      load: async () => {
        if (isFirstLoad) {
          isFirstLoad = false;
          return first;
        }
        return load();
      },
      send: async (body) => {
        const result = await this.client.send(slug, number, body);
        return result.ok ? { ok: true, response: result.value } : this.refusal(result.failure);
      },
      describe: (request, issue) => this.describe(request, issue),
      when: (iso) => `${localDayOf(iso, this.lang())}, ${localTimeOf(iso, this.lang())}`,
    };
    const ref = this.sheet.open<RequestFormResult, RequestFormData>(RequestFormDialog, {
      title:
        first === null ? `#${number}` : this.t('commands.request.title', { n: number, title: first.title }),
      data,
      autoFocus: 'input[type=radio]:checked',
    });
    return firstValueFrom(ref.closed);
  }

  /** The form's alert for a refusal, in words the owner can act on. */
  private refusal(failure: CommandFailure): RequestSendAnswer {
    switch (failure.kind) {
      case 'issue-changed': {
        const milestone = textOf(failure, 'milestone');
        return {
          ok: false,
          refill: true,
          message: this.t('commands.request.conflict', {
            where: milestone ?? this.t('commands.request.backlogWhere'),
          }),
        };
      }
      case 'sprint-next-missing':
        return { ok: false, refill: true, message: this.t('commands.request.nextMissing') };
      case 'sprint-none':
        return { ok: false, refill: true, message: this.t('commands.request.noCurrent') };
      case 'issue-closed':
        return { ok: false, isFinal: true, message: this.t('commands.request.closed') };
      case 'request-not-issue':
        return { ok: false, isFinal: true, message: this.t('commands.request.notIssue') };
      case 'request-in-progress':
        return { ok: false, message: this.t('commands.request.inProgress') };
      case 'github':
        return { ok: false, message: this.t('commands.request.timeout') };
      case 'github-rate-limited':
        return {
          ok: false,
          message: this.t('commands.error.githubRate', {
            time: localTimeOf(this.now() + (failure.retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000, this.lang()),
          }),
        };
      case 'not-connected':
        return { ok: false, message: this.t('commands.error.connect') };
      case 'offline':
        return { ok: false, message: this.t('commands.error.offline') };
      default:
        return { ok: false, message: this.t('commands.error.unknown') };
    }
  }

  private async statusOf(slug: string): Promise<TeamStatusDto | null> {
    if (this.store.slug() !== slug || this.store.status() === null) {
      await this.store.load(slug);
    }
    return this.store.slug() === slug ? this.store.status() : null;
  }

  private outcome(tone: CommandOutcome['tone'], verb: string, detail: string | null = null): CommandOutcome {
    return { tone, verb, detail, runLogUrl: null, at: new Date(this.now()).toISOString() };
  }

  private lang(): string {
    return this.transloco.getActiveLang();
  }

  private readonly t = (key: string, params?: Record<string, unknown>): string =>
    this.transloco.translate(key, params);
}
