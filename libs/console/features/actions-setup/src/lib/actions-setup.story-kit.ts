import { signal, type Provider } from '@angular/core';
import { provideRouter } from '@angular/router';
import { ActionsSetupApi } from '@console/entities/actions-setup';
import { RunnersApi } from '@console/entities/runner';
import { NetworkStatus } from '@console/shared/api';

export const STORY_PR_URL = 'https://github.com/geeera/storify/pull/42';
export const STORY_WORKFLOW = {
  text: 'name: Team Console runner\non:\n  workflow_dispatch:\n',
  sha256: 'a'.repeat(64),
  version: '0.42.0',
};

/** Offline-free stand-ins for the slices' API calls, shared by the Actions setup stories; `workflow` overrides the file read. */
export function actionsStoryProviders(options: { workflow?: ActionsSetupApi['workflow'] } = {}): Provider[] {
  return [
    provideRouter([]),
    { provide: NetworkStatus, useValue: { online: signal(true) } },
    {
      provide: ActionsSetupApi,
      useValue: {
        workflow: options.workflow ?? (async () => ({ ok: true, value: STORY_WORKFLOW })),
        openWorkflowPr: async () => ({ ok: true, value: { number: 42, url: STORY_PR_URL, kind: 'setup' } }),
      },
    },
    { provide: RunnersApi, useValue: { setDispatch: async () => ({ ok: true, value: { dispatch: 'actions', defaultBranch: 'main' } }) } },
  ];
}
