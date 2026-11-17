import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { expect, userEvent, waitFor } from 'storybook/test';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Ledger, LedgerRow } from '../ledger/ledger';
import { Switch } from './switch';

/** #688's role ledger: two interactive switches (on, off), one unavailable with a reason, one locked on. */
@Component({
  selector: 'tc-story-switch-ledger',
  imports: [FormsModule, Ledger, LedgerRow, Switch, TranslocoPipe],
  template: `
    <dl tc-ledger style="max-width: var(--task-pane-w)">
      <div tc-ledger-row [label]="'stories.switch.designer' | transloco">
        <button
          tc-switch
          type="button"
          [attr.aria-label]="'stories.switch.designer' | transloco"
          [ngModel]="designerOn()"
          (ngModelChange)="designerOn.set($event)"
        ></button>
      </div>
      <div tc-ledger-row [label]="'stories.switch.developer' | transloco">
        <button
          tc-switch
          type="button"
          [attr.aria-label]="'stories.switch.developer' | transloco"
          [ngModel]="developerOn()"
          (ngModelChange)="developerOn.set($event)"
        ></button>
      </div>
      <div tc-ledger-row [label]="'stories.switch.triage' | transloco">
        <button
          tc-switch
          type="button"
          off
          [attr.aria-label]="'stories.switch.triage' | transloco"
          aria-describedby="story-switch-triage-why"
          [ngModel]="false"
        ></button>
        <p id="story-switch-triage-why" style="margin: var(--space-1) 0 0; font-size: var(--fs-xs); color: var(--text-2)">
          {{ 'stories.switch.triageReason' | transloco }}
        </p>
      </div>
      <div tc-ledger-row [label]="'stories.switch.security' | transloco">
        <button
          tc-switch
          type="button"
          locked
          [attr.aria-label]="'stories.switch.security' | transloco"
          aria-describedby="story-switch-security-why"
          [ngModel]="true"
        ></button>
        <p
          id="story-switch-security-why"
          style="margin: var(--space-1) 0 0; font-size: var(--fs-xs); color: var(--text-2)"
        >
          {{ 'stories.switch.securityReason' | transloco }}
        </p>
      </div>
    </dl>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class SwitchLedgerStory {
  protected readonly designerOn = signal(true);
  protected readonly developerOn = signal(false);
}

const meta: Meta<Switch> = {
  title: 'Kit/Switch',
  component: Switch,
  decorators: [moduleMetadata({ imports: [SwitchLedgerStory] })],
  render: () => ({ template: '<tc-story-switch-ledger />' }),
};

export default meta;
type Story = StoryObj<Switch>;

export const States: Story = {};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };

/** Tabs to the first switch and toggles it with Space, then with Enter: both keys work, same as a native button. */
export const Focus: Story = {
  play: async ({ canvasElement }) => {
    const first = canvasElement.querySelector('button[tc-switch]') as HTMLButtonElement;
    first.focus();
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(first.getAttribute('aria-checked')).toBe('true');

    await userEvent.keyboard(' ');
    await waitFor(() => expect(first.getAttribute('aria-checked')).toBe('false'));

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(first.getAttribute('aria-checked')).toBe('true'));
  },
};
