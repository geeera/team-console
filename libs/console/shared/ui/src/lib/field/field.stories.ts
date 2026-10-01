import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Field, FieldControl } from './field';

const form = `
  <form style="display: grid; gap: var(--space-4); max-width: var(--dialog-max-w)" autocomplete="off">
    <tc-field [label]="'stories.field.repoLabel' | transloco" [hint]="'stories.field.repoHint' | transloco" required>
      <input tcInput type="text" name="repo" placeholder="geeera/team-console" />
    </tc-field>
    <tc-field [label]="'stories.field.repoLabel' | transloco" [error]="'stories.field.repoInvalidError' | transloco" required>
      <input tcInput type="text" name="repo-invalid" value="team console" />
    </tc-field>
    <tc-field [label]="'stories.field.repoLabel' | transloco" [hint]="'stories.field.repoHint' | transloco" [note]="'stories.field.repoNote' | transloco" required>
      <input tcInput type="text" name="repo-note" value="geeera/team-console" />
    </tc-field>
    <tc-field [label]="'stories.field.reasonLabel' | transloco" [hint]="'stories.field.reasonHint' | transloco">
      <textarea tcInput name="reason" rows="3"></textarea>
    </tc-field>
    <tc-field [label]="'stories.field.langLabel' | transloco">
      <select tcInput name="lang">
        <option value="ru">{{ 'stories.field.langRu' | transloco }}</option>
        <option value="en">{{ 'stories.field.langEn' | transloco }}</option>
      </select>
    </tc-field>
    <tc-field [label]="'stories.field.offlineLabel' | transloco">
      <input tcInput type="text" name="offline" value="geeera/team-console" disabled />
    </tc-field>
  </form>
`;

const meta: Meta<Field> = {
  title: 'Kit/Field',
  component: Field,
  decorators: [moduleMetadata({ imports: [Field, FieldControl, TranslocoPipe] })],
  argTypes: { required: { control: 'boolean' } },
  args: { required: true },
  render: (args) => ({
    props: args,
    template: `
      <tc-field [label]="'stories.field.repoLabel' | transloco" [hint]="'stories.field.repoHint' | transloco" [required]="required" style="max-width: var(--dialog-max-w)">
        <input tcInput type="text" name="repo" placeholder="geeera/team-console" />
      </tc-field>
    `,
  }),
};

export default meta;
type Story = StoryObj<Field>;

export const Playground: Story = {};
export const States: Story = { render: () => ({ template: form }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: form }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: form }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: form }) };
