// `renderTemplate` and the raw template stay internal: callers render the bundled template, never one of their own.
export {
  CONSOLE_AUDIENCE_PLACEHOLDER,
  CONSOLE_ORIGIN_PATTERN,
  CONSOLE_URL_PLACEHOLDER,
  RUN_STEP_NAME,
  isConsoleOrigin,
  renderRunnerWorkflow,
  type RunnerWorkflowFailure,
  type RunnerWorkflowInput,
  type RunnerWorkflowOutcome,
  type RunnerWorkflowPins,
  type RunnerWorkflowRendering,
} from './lib/render';
export { ACTIONS_SETUP_BRANCH_PREFIX, actionsSetupBranchOf } from './lib/setup-branch';
