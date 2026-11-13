import { JOB_EVENTS_MAX_PER_BATCH, type JobEventInput, type JobEventsResponse } from '@shared/contracts';

/**
 * A job's events on their way to the console: buffered, sent in batches of at most 50 (the console's limit) when a
 * batch is full or the flush timer fires, one request at a time so `seq` follows the CLI's order. A batch that fails
 * is reported and dropped; the job goes on (its finish still says how it ended).
 */
export interface EventSink {
  events(jobId: string, events: readonly JobEventInput[]): Promise<JobEventsResponse>;
}

export class EventQueue {
  private buffer: JobEventInput[] = [];
  private sending: Promise<void> = Promise.resolve();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly sink: EventSink,
    private readonly jobId: string,
    private readonly onError: (error: unknown) => void,
    flushMs: number,
  ) {
    this.timer = setInterval(() => void this.flush(), flushMs);
    this.timer.unref();
  }

  push(...events: readonly JobEventInput[]): void {
    this.buffer.push(...events);
    if (this.buffer.length >= JOB_EVENTS_MAX_PER_BATCH) {
      void this.flush();
    }
  }

  /** Sends everything buffered so far; resolves once it was sent (or reported). */
  flush(): Promise<void> {
    this.sending = this.sending.then(async () => {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, JOB_EVENTS_MAX_PER_BATCH);
        try {
          await this.sink.events(this.jobId, batch);
        } catch (error: unknown) {
          this.onError(error);
        }
      }
    });
    return this.sending;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}
