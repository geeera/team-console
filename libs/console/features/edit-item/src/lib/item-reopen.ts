import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { ItemsApi, newIdempotencyKey, type FailedWrite } from '@console/entities/item';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button } from '@console/shared/ui';
import type { ItemDto } from '@shared/contracts';

/** Reopen on a task closed as not needed (#409 §3): `state: open`, with `If-Match` and an idempotency key. */
@Component({
  selector: 'tc-item-reopen',
  imports: [Button, TranslocoPipe],
  template: `
    <button
      tc-button
      type="button"
      data-testid="item-reopen"
      [loading]="isSaving()"
      [off]="off() !== null || isSaving()"
      [attr.aria-disabled]="off() !== null || isSaving() ? 'true' : null"
      [attr.aria-describedby]="off() !== null ? 'tc-task-off' : null"
      (click)="reopen()"
    >
      {{ 'item.reopen' | transloco }}
    </button>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemReopen {
  private readonly api = inject(ItemsApi);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);

  readonly slug = input.required<string>();
  readonly item = input.required<ItemDto>();
  readonly off = input<string | null>(null);
  readonly changed = output<ItemDto>();
  readonly failed = output<FailedWrite>();

  protected readonly isSaving = signal(false);

  async reopen(): Promise<void> {
    if (this.off() !== null || this.isSaving()) {
      return;
    }
    await this.write(this.item().version, newIdempotencyKey());
  }

  private async write(version: number, key: string): Promise<void> {
    this.isSaving.set(true);
    const result = await this.api.update(this.slug(), this.item().number, version, { state: 'open' }, key);
    this.isSaving.set(false);
    if (!result.ok) {
      this.failed.emit({ failure: result.failure, retry: () => this.write(version, key) });
      return;
    }
    this.changed.emit(result.value);
    void this.announcer.announce(this.transloco.translate('item.ev.reopened'), 'polite');
  }
}
