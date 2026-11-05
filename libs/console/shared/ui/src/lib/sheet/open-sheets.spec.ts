import { TestBed } from '@angular/core/testing';
import { OpenSheets } from './open-sheets';

describe('OpenSheets', () => {
  it('does nothing before a Sheet exists, since nothing can be open then (#337)', () => {
    expect(() => TestBed.inject(OpenSheets).closeAll()).not.toThrow();
  });

  it('closes through the closer the Sheet attached', () => {
    const sheets = TestBed.inject(OpenSheets);
    const closeAll = vi.fn();
    sheets.attach(closeAll);

    sheets.closeAll();

    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  it('keeps the first closer and ignores a second attach with a warning (#433)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sheets = TestBed.inject(OpenSheets);
    const first = vi.fn();
    const second = vi.fn();
    sheets.attach(first);

    sheets.attach(second);
    sheets.closeAll();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('OpenSheets: a closer is already attached; ignoring the second attach');
    warn.mockRestore();
  });
});
