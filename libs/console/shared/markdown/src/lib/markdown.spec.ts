import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Markdown } from './markdown';
import type { RenderedMarkdown } from './rendered-markdown';

@Component({
  imports: [Markdown],
  template: `<tc-markdown [text]="text()" (rendered)="last = $event" />`,
})
class Host {
  readonly text = signal('Prototype: [states](https://a.pages.dev/x) <img src=x onerror="window.__pwned=1">');
  last: RenderedMarkdown | null = null;
}

describe('Markdown', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [Host], providers: [provideConsoleI18n()] }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('renders sanitised prose once the renderer has loaded, and reports its links', async () => {
    const { fixture, root } = await render();

    expect(root.querySelector('.tc-markdown a')?.getAttribute('href')).toBe('https://a.pages.dev/x');
    expect(root.querySelector('img, script, [onerror]')).toBeNull();
    expect(root.querySelector('.tc-markdown--plain')).toBeNull();
    expect(fixture.componentInstance.last?.links).toEqual(['https://a.pages.dev/x']);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('names a refused image in the interface language (#189)', async () => {
    const { root } = await render();

    expect(root.textContent).toContain('изображение');
    expect(root.textContent).not.toContain('image');
  });

  it('re-renders when the text changes', async () => {
    const { fixture, root } = await render();
    fixture.componentInstance.text.set('**bold**');
    await fixture.whenStable();

    expect(root.querySelector('.tc-markdown strong')?.textContent).toBe('bold');
    expect(fixture.componentInstance.last?.links).toEqual([]);
  });
});
