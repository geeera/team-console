import { ADD_PROJECT_URL, projectSetupRouteOf } from './project-routes';

describe('project routes', () => {
  it('sends Add project to the GitHub section of All projects', () => {
    expect(ADD_PROJECT_URL).toBe('/overview#add-project');
  });

  it('builds the setup page commands from the slug', () => {
    expect(projectSetupRouteOf('storify')).toEqual(['/settings/projects', 'storify']);
  });
});
