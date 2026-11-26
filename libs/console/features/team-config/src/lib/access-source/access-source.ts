import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@console/shared/i18n';
import { Callout, Choice, ChoiceGroup, Icon } from '@console/shared/ui';
import type { AccessSource as Source } from '@shared/contracts';
import { controlIdOf } from '../team-fields';

const ID = controlIdOf('access.source');

/**
 * "How the team reaches Claude" (#688, ADR 0009 d.3, threat model T7): API key or Claude subscription. The risk
 * warning is always printed under the subscription, chosen or not. While a hosted runner or an Actions dispatch can
 * reach the project the subscription stays focusable but `off` with its reason and a link to Runners; a forced save
 * that the Worker refused (`access-source-hosted`) shows as `error`. The choice itself is the caller's: choosing the
 * subscription needs its explicit confirmation first, so this only reports the pick.
 */
@Component({
  selector: 'tc-access-source',
  imports: [Callout, Choice, ChoiceGroup, Icon, RouterLink, TranslocoPipe],
  template: `
    @if (readOnly()) {
      <p class="access__value" data-testid="access-value">{{ 'teamConfig.value.' + source() | transloco }}</p>
      @if (source() === 'subscription') {
        <p tc-callout tone="warning" class="access__risk">{{ 'teamConfig.access.risk' | transloco }}</p>
      }
    } @else {
      <fieldset tc-choice-group [legend]="'teamConfig.section.access' | transloco" class="access__group">
        <label tc-choice>
          <input
            type="radio"
            data-testid="access-api-key"
            [id]="id"
            [name]="id"
            value="api_key"
            [checked]="source() === 'api_key'"
            [attr.aria-describedby]="id + '-api-hint'"
            (change)="choose.emit('api_key')"
          />
          {{ 'teamConfig.access.apiKey' | transloco }}
          <small tc-choice-hint [id]="id + '-api-hint'">{{
            'teamConfig.access.apiKeyHint' | transloco
          }}</small>
        </label>
        <label tc-choice [off]="blocked() && source() !== 'subscription'">
          <input
            type="radio"
            data-testid="access-subscription"
            data-control="access.source"
            [name]="id"
            value="subscription"
            [checked]="source() === 'subscription'"
            [attr.aria-describedby]="describedBy()"
            [attr.aria-invalid]="error() === null ? null : 'true'"
            (click)="pickSubscription($event)"
          />
          {{ 'teamConfig.access.subscription' | transloco }}
          <small tc-choice-hint [id]="id + '-risk'" class="access__risk-line">
            <tc-icon name="alert" size="sm" />{{ 'teamConfig.access.risk' | transloco }}
          </small>
          @if (blocked()) {
            <small tc-choice-hint [id]="id + '-blocked'" data-testid="access-blocked">
              {{ 'teamConfig.access.blocked' | transloco }}
            </small>
          }
        </label>
      </fieldset>
      @if (blocked()) {
        <a class="access__runners tc-tap-target" routerLink="/settings/runners" data-testid="access-runners">
          {{ 'teamConfig.access.runners' | transloco }}
        </a>
      }
      @if (error(); as error) {
        <p class="access__error" role="alert" data-testid="access-error" [id]="id + '-error'">
          <tc-icon name="alert" size="sm" /><span>{{ error }}</span>
        </p>
      }
    }
  `,
  styleUrl: './access-source.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccessSource {
  readonly source = input.required<Source>();
  /** A hosted runner or an Actions dispatch can reach the project: the subscription is off with its reason. */
  readonly blocked = input(false);
  readonly readOnly = input(false);
  /** The worded `access-source-hosted` refusal of a save. */
  readonly error = input<string | null>(null);

  readonly choose = output<Source>();

  protected readonly id = ID;

  protected describedBy(): string {
    return [
      `${ID}-risk`,
      ...(this.blocked() ? [`${ID}-blocked`] : []),
      ...(this.error() === null ? [] : [`${ID}-error`]),
    ].join(' ');
  }

  /** The radio never checks itself: the caller confirms first, then the source comes back through `source`. */
  protected pickSubscription(event: Event): void {
    event.preventDefault();
    if (this.source() !== 'subscription') {
      this.choose.emit('subscription');
    }
  }
}
