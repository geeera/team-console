import { TestBed } from '@angular/core/testing';
import { APP_CONFIG, provideAppConfig } from './app-config';

describe('provideAppConfig', () => {
  it('exposes the supplied config through APP_CONFIG', () => {
    TestBed.configureTestingModule({
      providers: [provideAppConfig({ name: 'Team Console', version: '1.2.3', builtAt: 'local' })],
    });

    expect(TestBed.inject(APP_CONFIG)).toEqual({ name: 'Team Console', version: '1.2.3', builtAt: 'local' });
  });

  it('fails loudly when nothing provided the config', () => {
    TestBed.configureTestingModule({});

    expect(() => TestBed.inject(APP_CONFIG)).toThrowError(/APP_CONFIG/);
  });
});
