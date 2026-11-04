import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideConsoleI18n } from '@console/shared/i18n';
import { ProjectSetupLink } from './project-setup-link';

@Component({
  imports: [ProjectSetupLink],
  template: `<tc-project-setup-link [slug]="slug()" />`,
})
class Host {
  readonly slug = signal('field-note');
}

describe('ProjectSetupLink', () => {
  async function render() {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideConsoleI18n(), provideRouter([])] });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const link = () =>
      (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(
        '[data-testid="project-setup-link"]',
      );
    return { fixture, link };
  }

  it("links to the project's setup page with the setup label", async () => {
    const { link } = await render();
    expect(link()?.getAttribute('href')).toBe('/settings/projects/field-note');
    expect(link()?.textContent?.trim()).toBe('Открыть настройку проекта');
  });

  it('follows the slug and encodes it', async () => {
    const { fixture, link } = await render();
    fixture.componentInstance.slug.set('a b');
    await fixture.whenStable();
    expect(link()?.getAttribute('href')).toBe('/settings/projects/a%20b');
  });
});
