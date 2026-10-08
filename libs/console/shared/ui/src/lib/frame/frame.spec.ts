import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Frame } from './frame';

const STORYBOOK = 'https://team-console-storybook.pages.dev';

@Component({
  imports: [Frame],
  template: `<tc-frame [src]="src()" [allowedOrigins]="origins()" [profile]="profile()" title="Storybook" />`,
})
class Host {
  readonly src = signal(`${STORYBOOK}/?path=/story/kit-card--default`);
  readonly origins = signal<readonly string[]>([STORYBOOK]);
  readonly profile = signal<'page' | 'design'>('page');
}

describe('Frame', () => {
  async function render() {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideConsoleI18n()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    return { fixture, element };
  }

  it('frames an allowed page in a sandbox without top navigation, referrer or features', async () => {
    const { element } = await render();
    const frame = element.querySelector('iframe');

    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('src')).toBe(`${STORYBOOK}/?path=/story/kit-card--default`);
    expect(frame?.getAttribute('title')).toBe('Storybook');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.hasAttribute('allow')).toBe(false);
    const sandbox = (frame?.getAttribute('sandbox') ?? '').split(/\s+/);
    expect(sandbox).toEqual([
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
    ]);
    expect(sandbox.some((token) => token.startsWith('allow-top-navigation'))).toBe(false);
    expect(element.querySelector('[data-testid="frame-refused"]')).toBeNull();
  });

  it('frames a design with scripts only — no same-origin, forms, popups or top navigation (#277)', async () => {
    const { fixture, element } = await render();
    fixture.componentInstance.profile.set('design');
    await fixture.whenStable();
    const frame = element.querySelector('iframe');

    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('allow')).toBe('');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.getAttribute('loading')).toBe('lazy');
    expect(frame?.hasAttribute('srcdoc')).toBe(false);
    expect(frame?.getAttribute('src')).toBe(`${STORYBOOK}/?path=/story/kit-card--default`);
  });

  it('always offers the page in a new tab without opener or referrer', async () => {
    const { element } = await render();
    const open = element.querySelector<HTMLAnchorElement>('[data-testid="frame-open"]');

    expect(open?.getAttribute('href')).toBe(`${STORYBOOK}/?path=/story/kit-card--default`);
    expect(open?.getAttribute('target')).toBe('_blank');
    expect(open?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(open?.textContent).toContain('team-console-storybook.pages.dev');
    expect(open?.textContent).toContain('Открыть в новой вкладке');
  });

  it.each([
    ['another project on the same family', 'https://evil.pages.dev/'],
    ['a loopback address', 'https://127.0.0.1/'],
    ['plain http', 'http://team-console-storybook.pages.dev/'],
  ])('shows %s as "can\'t be shown here" with a link and no frame', async (_name, src) => {
    const { fixture, element } = await render();
    fixture.componentInstance.src.set(src);
    await fixture.whenStable();

    expect(element.querySelector('iframe')).toBeNull();
    expect(element.querySelector('[data-testid="frame-refused"]')?.textContent).toContain(
      'Эту страницу нельзя показать в консоли',
    );
    const open = element.querySelector<HTMLAnchorElement>('[data-testid="frame-open"]');
    expect(open?.getAttribute('href')).toBe(new URL(src).href);
    expect(open?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders no link at all for a value that is not a web page', async () => {
    const { fixture, element } = await render();
    fixture.componentInstance.src.set('javascript:alert(1)');
    await fixture.whenStable();

    expect(element.querySelector('iframe')).toBeNull();
    expect(element.querySelector('[data-testid="frame-open"]')).toBeNull();
    expect(element.querySelector('[data-testid="frame-refused"]')).not.toBeNull();
  });

  it('stops framing as soon as the origin leaves the allow-list', async () => {
    const { fixture, element } = await render();
    fixture.componentInstance.origins.set([]);
    await fixture.whenStable();

    expect(element.querySelector('iframe')).toBeNull();
    expect(element.querySelector('[data-testid="frame-refused"]')).not.toBeNull();
  });
});
