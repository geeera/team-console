import { ApplicationInitStatus, ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import { ENVIRONMENT_COPY_LOADER, EnvironmentCopy, type EnvironmentCopyChunks } from './environment-copy';
import EN from './copy/en.json';
import RU from './copy/ru.json';

describe('EnvironmentCopy', () => {
  const handleError = vi.fn();

  async function setup(loader: () => Promise<EnvironmentCopyChunks>): Promise<EnvironmentCopy> {
    handleError.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        { provide: ErrorHandler, useValue: { handleError } },
        { provide: ENVIRONMENT_COPY_LOADER, useValue: loader },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    return TestBed.inject(EnvironmentCopy);
  }

  it('merges both languages under env.* and loads once', async () => {
    const loader = vi.fn(async () => ({ ru: RU, en: EN }));
    const copy = await setup(loader);

    expect(await copy.ready()).toBe(true);
    expect(await copy.ready()).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(copy.loaded()).toBe(true);
    expect(TestBed.inject(TranslocoService).translate('env.title')).toBe('Настройка окружения');
  });

  it('reports a chunk that cannot load, says it failed, and tries again on the next call', async () => {
    const chunkError = new Error('Failed to fetch dynamically imported module');
    const loader = vi
      .fn<() => Promise<EnvironmentCopyChunks>>()
      .mockRejectedValueOnce(chunkError)
      .mockResolvedValue({ ru: RU, en: EN });
    const copy = await setup(loader);

    expect(await copy.ready()).toBe(false);
    expect(handleError).toHaveBeenCalledWith(chunkError);
    expect(copy.failed()).toBe(true);
    expect(copy.loaded()).toBe(false);

    expect(await copy.ready()).toBe(true);
    expect(copy.failed()).toBe(false);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
