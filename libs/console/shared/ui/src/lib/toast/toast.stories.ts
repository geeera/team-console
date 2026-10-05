import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { ToastOutlet, Toaster } from './toast';

@Component({
  selector: 'tc-story-toast-host',
  imports: [Button, ToastOutlet, TranslocoPipe],
  template: `
    <button tc-button variant="primary" type="button" (click)="show()">
      {{ 'stories.toast.show' | transloco }}
    </button>
    <tc-toast-outlet />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class ToastHost {
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);

  constructor() {
    // Shown at once so the story (and its axe run) has a message to look at.
    this.show();
  }

  protected show(): void {
    this.toaster.show(this.transloco.translate('stories.toast.archived'));
  }
}

const meta: Meta<ToastHost> = {
  title: 'Kit/Toast',
  component: ToastHost,
  decorators: [moduleMetadata({ imports: [ToastHost] })],
  render: () => ({ template: '<tc-story-toast-host />' }),
};

export default meta;
type Story = StoryObj<ToastHost>;

export const Default: Story = {};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
