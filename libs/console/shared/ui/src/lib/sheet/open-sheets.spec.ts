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
});
