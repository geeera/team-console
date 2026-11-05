import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { Menu } from './menu';

/** Opens the #409 Move menu: an off item with its reason, a full sprint's warning, two groups. */
@Component({
  selector: 'tc-menu-story',
  imports: [Button, TranslocoPipe],
  template: `
    <button
      #opener
      tc-button
      type="button"
      aria-haspopup="menu"
      [attr.aria-expanded]="isOpen()"
      (click)="open()"
    >
      {{ 'stories.menu.open' | transloco }}
    </button>
    <p>{{ picked() }}</p>
  `,
})
class MenuStory {
  private readonly menu = inject(Menu);
  private readonly transloco = inject(TranslocoService);
  private readonly opener = viewChild.required('opener', { read: ElementRef<HTMLButtonElement> });
  protected readonly isOpen = signal(false);
  protected readonly picked = signal('');

  protected async open(): Promise<void> {
    if (this.isOpen()) {
      return;
    }
    const t = (key: string): string => this.transloco.translate(`stories.menu.${key}`);
    this.isOpen.set(true);
    const id = await this.menu.open(this.opener().nativeElement, {
      label: t('label'),
      title: t('title'),
      subtitle: t('subtitle'),
      warning: t('warning'),
      groups: [
        {
          label: t('sprints'),
          items: [
            { id: 'current', label: t('current'), off: t('here') },
            { id: 'next', label: t('next'), hint: t('nextHint') },
            { id: 'later', label: t('later'), hint: t('full'), hintTone: 'warning' },
          ],
        },
        { items: [{ id: 'backlog', label: t('backlog') }] },
      ],
    });
    this.isOpen.set(false);
    this.picked.set(id ?? '');
  }
}

const meta: Meta<MenuStory> = { title: 'Kit/Menu', component: MenuStory };

export default meta;
type Story = StoryObj<MenuStory>;

export const Popover: Story = {};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const PhoneSheet: Story = { ...phoneViewport };
