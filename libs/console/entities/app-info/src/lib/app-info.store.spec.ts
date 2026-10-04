import { TestBed } from '@angular/core/testing';
import { provideAppConfig } from '@console/shared/config';
import { AppInfoStore } from './app-info.store';

describe('AppInfoStore', () => {
  it('exposes the app config as signals', () => {
    TestBed.configureTestingModule({
      providers: [
        provideAppConfig({ name: 'Team Console', version: '0.1.0', builtAt: '2026-09-29T10:00:00.000Z' }),
      ],
    });
    const store = TestBed.inject(AppInfoStore);

    expect(store.name()).toBe('Team Console');
    expect(store.version()).toBe('0.1.0');
    expect(store.builtAt()).toBe('2026-09-29T10:00:00.000Z');
    expect(store.isLocalBuild()).toBe(false);
  });

  it('flags a developer build', () => {
    TestBed.configureTestingModule({
      providers: [provideAppConfig({ name: 'Team Console', version: '0.1.0', builtAt: 'local' })],
    });

    expect(TestBed.inject(AppInfoStore).isLocalBuild()).toBe(true);
  });
});
