import { ApplicationInitStatus, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { PermissionSettingsLink } from './permission-settings-link';

const SETTINGS = 'https://github.com/settings/installations/7';

@Component({
  imports: [PermissionSettingsLink],
  template: `<tc-permission-settings-link url="${SETTINGS}" />`,
})
class Host {}

describe('PermissionSettingsLink (#792)', () => {
  it('opens the installation settings page in a new tab and says so to a screen reader', async () => {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideConsoleI18n()] });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(
      '[data-testid="permission-settings-link"]',
    );
    expect(link?.getAttribute('href')).toBe(SETTINGS);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Открыть настройки установки (откроется на GitHub)',
    );
  });
});
