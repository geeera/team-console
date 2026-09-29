import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Field, FieldControl } from './field';

const form = `
  <form style="display: grid; gap: var(--space-4); max-width: var(--dialog-max-w)" autocomplete="off">
    <tc-field label="Репозиторий" hint="owner/repo или ссылка на GitHub" required>
      <input tcInput type="text" name="repo" placeholder="geeera/team-console" />
    </tc-field>
    <tc-field label="Репозиторий" error="Не похоже на owner/repo" required>
      <input tcInput type="text" name="repo-invalid" value="team console" />
    </tc-field>
    <tc-field label="Причина отказа" hint="Команда увидит её в комментарии">
      <textarea tcInput name="reason" rows="3"></textarea>
    </tc-field>
    <tc-field label="Язык">
      <select tcInput name="lang">
        <option value="ru">Русский</option>
        <option value="en">English</option>
      </select>
    </tc-field>
    <tc-field label="Недоступно офлайн">
      <input tcInput type="text" name="offline" value="geeera/team-console" disabled />
    </tc-field>
  </form>
`;

const meta: Meta<Field> = {
  title: 'Kit/Field',
  component: Field,
  decorators: [moduleMetadata({ imports: [Field, FieldControl] })],
  args: { label: 'Репозиторий', hint: 'owner/repo или ссылка на GitHub', error: '', required: true },
  render: (args) => ({
    props: args,
    template: `
      <tc-field [label]="label" [hint]="hint" [error]="error" [required]="required" style="max-width: var(--dialog-max-w)">
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
