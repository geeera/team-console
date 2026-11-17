import {
  ADD_PROJECT_URL,
  projectEnvironmentGuideRouteOf,
  projectEnvironmentRouteOf,
  projectSetupRouteOf,
} from './project-routes';

describe('project routes', () => {
  it('sends Add project to the GitHub section of All projects', () => {
    expect(ADD_PROJECT_URL).toBe('/overview#add-project');
  });

  it('builds the setup page commands from the slug', () => {
    expect(projectSetupRouteOf('storify')).toEqual(['/settings/projects', 'storify']);
  });

  it('puts the project environment and its guides under the setup page (#750)', () => {
    expect(projectEnvironmentRouteOf('storify')).toEqual(['/settings/projects', 'storify', 'environment']);
    expect(projectEnvironmentGuideRouteOf('storify', 'production', 'ROUTINE_TOKEN_STORIFY')).toEqual([
      '/settings/projects',
      'storify',
      'environment',
      'production',
      'ROUTINE_TOKEN_STORIFY',
    ]);
  });
});
