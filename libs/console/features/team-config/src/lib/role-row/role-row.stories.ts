import { TEAM_CONFIG_PRESET_ROLES, type TeamRole, type TeamRoleSettings } from '@shared/contracts';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { RoleRow } from './role-row';

interface Args {
  readonly teamRole: TeamRole;
  readonly settings: TeamRoleSettings;
  readonly isOverridden: boolean;
  readonly readOnly: boolean;
  readonly modelError: string | null;
}

const PRESET = TEAM_CONFIG_PRESET_ROLES.recommended;

const meta: Meta<Args> = {
  title: 'Features/Team config/Role row',
  decorators: [moduleMetadata({ imports: [RoleRow] })],
  render: (args) => ({
    props: args,
    template: `
      <div role="list" style="max-width: var(--board-max); border: var(--border-w) solid var(--border)">
        <tc-role-row
          [teamRole]="teamRole"
          [settings]="settings"
          [isOverridden]="isOverridden"
          [readOnly]="readOnly"
          [modelError]="modelError"
        />
      </div>
    `,
  }),
  args: {
    teamRole: 'architect',
    settings: PRESET.architect,
    isOverridden: false,
    readOnly: false,
    modelError: null,
  },
};

export default meta;
type Story = StoryObj<Args>;

/** A role the owner may switch: on, on its preset's model. */
export const On: Story = {};
/** Off: the model and limits are dimmed and the line says no jobs are created for it. */
export const Off: Story = {
  args: { teamRole: 'ui-designer', settings: { ...PRESET['ui-designer'], enabled: false } },
};
/** One of the five never-off roles: the switch is locked, focusable, with its reason. */
export const Locked: Story = { args: { teamRole: 'orchestrator', settings: PRESET.orchestrator } };
/** Security has no switch, only the reason. */
export const Security: Story = { args: { teamRole: 'security', settings: PRESET.security } };
/** A model other than the preset's: the word chip "Override" and its own Reset. */
export const Override: Story = {
  args: {
    teamRole: 'qa',
    settings: { ...PRESET.qa, model: 'claude-sonnet-5', effort: 'medium', max_turns: 500 },
    isOverridden: true,
  },
};
/** A member: the values as text, no control. */
export const ReadOnly: Story = { args: { teamRole: 'qa', readOnly: true, settings: PRESET.qa } };
/** A 422 that named this role's model. */
export const WithError: Story = {
  args: { teamRole: 'dev', settings: PRESET.dev, modelError: 'Проверьте поле «Разработчик · модель».' },
};
