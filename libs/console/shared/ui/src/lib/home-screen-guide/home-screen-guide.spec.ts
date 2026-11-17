import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { HomeScreenGuide } from './home-screen-guide';

@Component({
  imports: [HomeScreenGuide],
  template: `<tc-home-screen-guide [otherBrowser]="other()" finalStep="Откройте со значка." listId="steps-1" />`,
})
class Host {
  readonly other = signal(false);
}

describe('HomeScreenGuide', () => {
  async function render(other: boolean) {
    await TestBed.configureTestingModule({ imports: [Host], providers: [provideConsoleI18n()] }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.other.set(other);
    await fixture.whenStable();
    return (fixture.nativeElement as HTMLElement).querySelector('ol') as HTMLOListElement;
  }

  it('lists the three Safari steps with the caller’s last step and names Safari’s buttons', async () => {
    const list = await render(false);
    const steps = list.querySelectorAll('li');

    expect(list.id).toBe('steps-1');
    expect(list.getAttribute('aria-label')).toBe('Как добавить на экран «Домой»');
    expect(steps).toHaveLength(3);
    expect(steps[0]?.textContent).toContain('Ещё');
    expect(steps[0]?.textContent).toContain('Поделиться');
    expect(steps[2]?.querySelector('p')?.textContent?.trim()).toBe('Откройте со значка.');
  });

  it('points other iOS browsers to Share in the address bar', async () => {
    const list = await render(true);
    const first = list.querySelector('[data-testid="guide-step-other"]');

    expect(first?.textContent).toContain('в адресной строке браузера');
    expect(list.querySelectorAll('li')).toHaveLength(3);
  });
});
