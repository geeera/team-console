import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { DesignPreview } from './design-preview';
import { DesignSummary } from './design-summary';
import { MANIFEST, screen } from './design.model.spec';

@Component({
  imports: [DesignPreview, DesignSummary],
  template: `<tc-design-preview [slug]="slug" [issue]="issue()" /><tc-design-summary [slug]="slug" [issue]="issue()" />`,
})
class Host {
  readonly slug = 'tc';
  readonly issue = signal(277);
}

/** The store sets its signal a microtask after the flush; a macrotask later the view has caught up. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('DesignPreview and DesignSummary', () => {
  let http: HttpTestingController;

  async function render() {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideConsoleI18n(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('shows a skeleton, then the first phone screen as a decorative image from the file route, and the summary', async () => {
    const { fixture, root } = await render();
    expect(root.querySelector('[data-testid="design-thumb-loading"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="design-summary"]')?.textContent?.trim()).toBe('#277');

    http.expectOne('/api/v1/projects/tc/designs/277').flush(MANIFEST);
    await settle();
    await fixture.whenStable();

    const img = root.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(
      `/api/v1/projects/tc/designs/277/${MANIFEST.sha}/file?path=docs%2Fdesign%2F277-viewer%2Fphone-01-list.png`,
    );
    expect(img.getAttribute('alt')).toBe('');
    expect(root.querySelector('iframe, svg, object')).toBeNull();
    expect(root.querySelector('[data-testid="design-summary"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '#277 · 3 экрана · iPhone и Mac',
    );
  });

  it('says HTML when the design has only an interactive version, and a dash when it has nothing', async () => {
    const { fixture, root } = await render();
    http.expectOne('/api/v1/projects/tc/designs/277').flush({ ...MANIFEST, screens: [] });
    await settle();
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="design-thumb-none"]')?.textContent?.trim()).toBe('HTML');
    expect(root.querySelector('[data-testid="design-summary"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '#277 · только интерактивная версия',
    );

    fixture.componentInstance.issue.set(278);
    await fixture.whenStable();
    http.expectOne('/api/v1/projects/tc/designs/278').flush({ ...MANIFEST, issue: 278, screens: [], interactive: null });
    await settle();
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="design-thumb-none"]')?.textContent?.trim()).toBe('—');
    expect(root.querySelector('[data-testid="design-summary"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '#278 · без картинок',
    );
  });

  it('falls back to a placeholder when the image fails to load, and names one device alone', async () => {
    const { fixture, root } = await render();
    http.expectOne('/api/v1/projects/tc/designs/277').flush({ ...MANIFEST, screens: [screen('mac-01.png')] });
    await settle();
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="design-summary"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '#277 · 1 экран · Mac',
    );
    root.querySelector('img')?.dispatchEvent(new Event('error'));
    await settle();
    // A failed thumbnail refetches the list once; the same commit again means the file is really gone.
    http.expectOne('/api/v1/projects/tc/designs/277').flush({ ...MANIFEST, screens: [screen('mac-01.png')] });
    await settle();
    await fixture.whenStable();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('[data-testid="design-thumb-failed"]')).not.toBeNull();
  });

  it('recovers a thumbnail when the design moved to another commit', async () => {
    const { fixture, root } = await render();
    http.expectOne('/api/v1/projects/tc/designs/277').flush(MANIFEST);
    await settle();
    await fixture.whenStable();
    root.querySelector('img')?.dispatchEvent(new Event('error'));
    await settle();
    http.expectOne('/api/v1/projects/tc/designs/277').flush({ ...MANIFEST, sha: 'b'.repeat(40) });
    await settle();
    await fixture.whenStable();
    const img = root.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toContain('b'.repeat(40));
  });

  it('shows the placeholder when the manifest cannot be read', async () => {
    const { fixture, root } = await render();
    http.expectOne('/api/v1/projects/tc/designs/277').flush({}, { status: 404, statusText: 'Not Found' });
    await settle();
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="design-thumb-failed"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="design-summary"]')?.textContent?.trim()).toBe('#277');
  });
});
