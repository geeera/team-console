import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Icon, type IconName } from './icon';

@Component({
  imports: [Icon],
  template: `<tc-icon [name]="name()" [label]="label()" />`,
})
class Host {
  readonly name = signal<IconName>('bell');
  readonly label = signal('');
}

describe('Icon', () => {
  it.each<IconName>(['bell', 'bell-off', 'share', 'more', 'add-square'])('draws the %s glyph', async (name) => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.name.set(name);
    await fixture.whenStable();

    const path = (fixture.nativeElement as HTMLElement).querySelector('path');
    expect(path?.getAttribute('d')).toMatch(/^M/);
  });

  it('is hidden from assistive tech unless it is given a label', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const icon = (fixture.nativeElement as HTMLElement).querySelector('tc-icon') as HTMLElement;
    expect(icon.getAttribute('aria-hidden')).toBe('true');

    fixture.componentInstance.label.set('Notifications');
    await fixture.whenStable();
    expect(icon.getAttribute('aria-hidden')).toBeNull();
    expect(icon.getAttribute('role')).toBe('img');
    expect(icon.getAttribute('aria-label')).toBe('Notifications');
  });
});
