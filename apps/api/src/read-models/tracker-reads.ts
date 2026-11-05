import { itemKeyOf, type AnswerCommand, type InboxDto, type QuestionsDto } from '@shared/contracts';
import { withoutInvisibles } from '@shared/plain-text';
import type { Logger } from '@worker/core';
import { INBOX_ROW_CAP, InboxRepo, type TrackerProject } from '@worker/db';
import {
  buildTrackerInbox,
  buildTrackerQuestions,
  trackerInboxItemsOf,
  type TrackerInboxRow,
} from '@worker/read-models';
import { labelsOf } from '../tracker/dto';

/** Whether a project's inbox comes from D1 rows rather than GitHub Issues (ADR 0006 decision 12). */
export function readsRows(project: TrackerProject | undefined | null): project is TrackerProject {
  return (
    project !== undefined && project !== null && project.tracker !== 'github' && project.keyPrefix !== null
  );
}

/**
 * The Needs-you reads of a console-tracker project (#434): one D1 query, no GitHub subrequest, so these projects
 * are read in full and never count against `NEEDS_YOU_MAX_PROJECTS`. Both paths produce the same DTOs.
 */
export class TrackerReads {
  constructor(
    private readonly db: D1Database,
    private readonly project: TrackerProject & { readonly keyPrefix: string },
    private readonly logger: Logger,
  ) {}

  static of(db: D1Database, project: TrackerProject, logger: Logger): TrackerReads {
    if (project.keyPrefix === null) {
      throw new Error('a project on the console tracker always has a key prefix');
    }
    return new TrackerReads(db, { ...project, keyPrefix: project.keyPrefix }, logger);
  }

  private async rows(): Promise<TrackerInboxRow[]> {
    const { rows, truncated } = await new InboxRepo(this.db).listOpen(this.project.slug);
    if (truncated) {
      // A project with more open owner-facing items than this has a bigger problem than its inbox.
      this.logger.warn('tracker inbox truncated', { slug: this.project.slug, cap: INBOX_ROW_CAP });
    }
    return rows.map(({ item, ask }) => ({
      key: itemKeyOf(this.project.keyPrefix, item.number),
      number: item.number,
      kind: item.kind,
      title: withoutInvisibles(item.title),
      body: item.body,
      labels: labelsOf(item),
      createdByKind: item.createdByKind,
      ask:
        ask === null
          ? null
          : { id: ask.id, ask: ask.ask, category: ask.category, commands: ask.commands, recommended: ask.recommended },
    }));
  }

  async inbox(): Promise<InboxDto> {
    return buildTrackerInbox(await this.rows());
  }

  async questions(): Promise<QuestionsDto> {
    return buildTrackerQuestions(await this.rows());
  }

  /** The inbox and, per item number, the commands its open ask accepts (Needs you lists them per item). */
  async needsYou(): Promise<{
    readonly inbox: InboxDto;
    readonly allowedCommands: ReadonlyMap<number, readonly AnswerCommand[]>;
  }> {
    const rows = await this.rows();
    return {
      inbox: buildTrackerInbox(rows),
      allowedCommands: new Map(
        trackerInboxItemsOf(rows).map(({ item, allowedCommands }) => [item.number, allowedCommands]),
      ),
    };
  }
}
