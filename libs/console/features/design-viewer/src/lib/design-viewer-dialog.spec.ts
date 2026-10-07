import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { DesignManifestDto, DesignScreenDto } from '@shared/contracts';
import { DesignViewer } from './design-viewer';

const SHA = 'a'.repeat(40);
const PAGES = 'https://geeera.github.io';

function screen(file: string, extra: Partial<DesignScreenDto> = {}): DesignScreenDto {
  return {
    path: `docs/design/277-viewer/${file}`,
    file,
    caption: file.replace(/^(?:phone|mac)-\d+-/, '').replace(/\.\w+$/, ''),
    device: file.startsWith('phone-') ? 'phone' : file.startsWith('mac-') ? 'mac' : null,
    type: 'png',
    size: 1000,
    tooLarge: false,
    url: `https://github.com/geeera/team-console/blob/${SHA}/docs/design/277-viewer/${file}`,
    ...extra,
  };
}

const MANIFEST: DesignManifestDto = {
  issue: 277,
  sha: SHA,
  ref: 'pull-request',
  screens: [
    screen('mac-01-list.png'),
    screen('phone-01-list.png'),
    screen('phone-02-grid.png'),
    screen('phone-03-huge.png', { tooLarge: true, size: 12_582_912 }),
  ],
  interactive: { path: 'docs/design/277-viewer/wireframe.html', url: `${PAGES}/team-console/277-viewer/wireframe.html` },
  partial: false,
};

@Component({ template: `<button type="button" class="opener">Open</button>` })
class Host {}

const overlay = (): HTMLElement => document.querySelector('.cdk-overlay-container') as HTMLElement;
const dialog = (): HTMLElement => overlay().querySelector('tc-sheet-container') as HTMLElement;
const byTestId = <T extends Element>(testId: string): T | null => dialog().querySelector<T>(`[data-testid="${testId}"]`);
const allByTestId = (testId: string): Element[] => Array.from(dialog().querySelectorAll(`[data-testid="${testId}"]`));
const text = (testId: string): string => byTestId(testId)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('DesignViewer', () => {
  let http: HttpTestingController;
  let viewer: DesignViewer;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideConsoleI18n(), provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    viewer = TestBed.inject(DesignViewer);
  });

  afterEach(() => {
    overlay()?.remove();
  });

  async function open(manifest: DesignManifestDto | { status: number } = MANIFEST, issue = 277) {
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    const opener = (fixture.nativeElement as HTMLElement).querySelector('.opener') as HTMLButtonElement;
    opener.focus();
    const ref = viewer.open({ slug: 'tc', issue, title: 'Viewer <b>design</b>' });
    await settle();
    const request = http.expectOne(`/api/v1/projects/tc/designs/${issue}`);
    if ('status' in manifest) {
      request.flush({}, { status: manifest.status, statusText: 'x' });
    } else {
      request.flush(manifest);
    }
    await settle();
    await settle();
    return { fixture, opener, ref };
  }

  it('opens a full-size modal dialog named by the title with focus on ✕, in images mode on the first screen', async () => {
    await open();
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(dialog().classList).toContain('tc-sheet--full');
    const titleId = dialog().getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(titleId)?.textContent?.trim()).toBe('Viewer <b>design</b>');
    expect(document.activeElement).toBe(dialog().querySelector('.tc-sheet__close'));

    // jsdom matches no phone breakpoint: the Mac is the device, with its one screen.
    const mac = allByTestId('viewer-device').find((b) => b.getAttribute('data-device') === 'mac');
    expect(mac?.getAttribute('aria-pressed')).toBe('true');
    const img = byTestId<HTMLImageElement>('viewer-screen');
    expect(img?.getAttribute('src')).toBe(
      `/api/v1/projects/tc/designs/277/${SHA}/file?path=docs%2Fdesign%2F277-viewer%2Fmac-01-list.png`,
    );
    expect(img?.getAttribute('alt')).toBe('Экран 1 из 1: list');
    expect(text('viewer-position')).toBe('1 из 1 · list');
    expect(dialog().querySelector('iframe, object, embed, [srcdoc]')).toBeNull();
  });

  it('moves through the phone screens with the buttons and the arrow keys, announcing the position', async () => {
    await open();
    allByTestId('viewer-device').find((b) => b.getAttribute('data-device') === 'phone')?.dispatchEvent(new Event('click'));
    await settle();
    expect(text('viewer-position')).toBe('1 из 3 · list');
    expect(byTestId('viewer-prev')?.getAttribute('aria-disabled')).toBe('true');
    expect(byTestId('viewer-position')?.getAttribute('aria-live')).toBe('polite');

    byTestId<HTMLButtonElement>('viewer-next')?.click();
    await settle();
    expect(text('viewer-position')).toBe('2 из 3 · grid');
    expect(byTestId<HTMLImageElement>('viewer-screen')?.getAttribute('data-path')).toContain('phone-02-grid.png');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();
    expect(text('viewer-position')).toBe('3 из 3 · huge');
    expect(byTestId('viewer-next')?.getAttribute('aria-disabled')).toBe('true');
    // The last one is too large: a note with the GitHub link instead of an image.
    expect(byTestId('viewer-too-large')?.textContent).toContain('12 МБ');
    expect(byTestId('viewer-too-large')?.querySelector('a')?.getAttribute('href')).toBe(MANIFEST.screens[3]?.url);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await settle();
    expect(text('viewer-position')).toBe('2 из 3 · grid');
    // Past the first: the position stays and the buttons are aria-disabled, never removed.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await settle();
    expect(text('viewer-position')).toBe('1 из 3 · list');
    expect(byTestId('viewer-prev')).not.toBeNull();
  });

  it('turns the page on a touch swipe, not on a short or vertical move', async () => {
    await open();
    allByTestId('viewer-device').find((b) => b.getAttribute('data-device') === 'phone')?.dispatchEvent(new Event('click'));
    await settle();
    const stage = byTestId<HTMLElement>('viewer-stage') as HTMLElement;
    const swipe = (dx: number, dy: number): void => {
      stage.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: 200, clientY: 300 }));
      stage.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', clientX: 200 + dx, clientY: 300 + dy }));
    };
    swipe(-120, 10);
    await settle();
    expect(text('viewer-position')).toBe('2 из 3 · grid');
    swipe(-20, 0);
    swipe(-100, 200);
    await settle();
    expect(text('viewer-position')).toBe('2 из 3 · grid');
    swipe(120, 0);
    await settle();
    expect(text('viewer-position')).toBe('1 из 3 · list');
  });

  it('zooms with the toggle (aria-pressed) and makes the stage a focusable region; a new screen fits again', async () => {
    await open();
    const zoom = byTestId<HTMLButtonElement>('viewer-zoom') as HTMLButtonElement;
    expect(zoom.getAttribute('aria-pressed')).toBe('false');
    expect(zoom.textContent?.trim()).toBe('Увеличить');
    zoom.click();
    await settle();
    expect(zoom.getAttribute('aria-pressed')).toBe('true');
    expect(zoom.textContent?.trim()).toBe('Уместить');
    expect(byTestId('viewer-screen')?.classList).toContain('viewer__img--zoomed');
    const stage = byTestId<HTMLElement>('viewer-stage');
    expect(stage?.getAttribute('tabindex')).toBe('0');
    expect(stage?.getAttribute('role')).toBe('region');

    allByTestId('viewer-device').find((b) => b.getAttribute('data-device') === 'phone')?.dispatchEvent(new Event('click'));
    await settle();
    expect(byTestId('viewer-zoom')?.getAttribute('aria-pressed')).toBe('false');
    expect(byTestId('viewer-stage')?.getAttribute('tabindex')).toBeNull();
  });

  it('shows the grid of every screen of the device with aria-current, and a cell opens it in images', async () => {
    await open();
    allByTestId('viewer-device').find((b) => b.getAttribute('data-device') === 'phone')?.dispatchEvent(new Event('click'));
    await settle();
    allByTestId('viewer-mode').find((b) => b.getAttribute('data-mode') === 'grid')?.dispatchEvent(new Event('click'));
    await settle();
    const cells = allByTestId('viewer-grid-item');
    expect(cells).toHaveLength(3);
    expect(cells[0]?.getAttribute('aria-current')).toBe('true');
    expect(cells[1]?.getAttribute('aria-label')).toBe('Экран 2: grid');
    expect(byTestId('viewer-position')).toBeNull();

    (cells[1] as HTMLButtonElement).click();
    await settle();
    await settle();
    expect(allByTestId('viewer-mode').find((b) => b.getAttribute('data-mode') === 'images')?.getAttribute('aria-pressed')).toBe('true');
    expect(text('viewer-position')).toBe('2 из 3 · grid');
    expect(document.activeElement).toBe(byTestId('viewer-next'));
  });

  it('frames the interactive version only from an allowed origin, in the strict profile, else says it cannot', async () => {
    await open();
    allByTestId('viewer-mode').find((b) => b.getAttribute('data-mode') === 'interactive')?.dispatchEvent(new Event('click'));
    await settle();
    http.expectOne('/api/v1/projects/tc/embed-origins').flush({ embedOrigins: ['https://team-console-storybook.pages.dev'] });
    await settle();
    await settle();
    expect(byTestId('viewer-frame')).toBeNull();
    expect(dialog().querySelector('iframe')).toBeNull();
    const refused = byTestId('viewer-interactive-refused');
    expect(refused?.textContent).toContain('Интерактивную версию нельзя показать в консоли');
    const link = byTestId<HTMLAnchorElement>('viewer-open-interactive');
    expect(link?.getAttribute('href')).toBe(MANIFEST.interactive?.url);
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    // Back to the images from the note.
    (refused?.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(byTestId('viewer-screen')).not.toBeNull();
  });

  it('frames the wireframe with sandbox="allow-scripts" exactly when GitHub Pages is an embed origin', async () => {
    await open();
    allByTestId('viewer-mode').find((b) => b.getAttribute('data-mode') === 'interactive')?.dispatchEvent(new Event('click'));
    await settle();
    http.expectOne('/api/v1/projects/tc/embed-origins').flush({ embedOrigins: [PAGES] });
    await settle();
    await settle();
    const frame = dialog().querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('src')).toBe(MANIFEST.interactive?.url);
    expect(frame?.getAttribute('title')).toBe('Интерактивная версия: Viewer <b>design</b>');
    expect(frame?.hasAttribute('srcdoc')).toBe(false);
    expect(byTestId('viewer-stage')?.classList).toContain('viewer__stage--frame');
    expect(byTestId('viewer-position')).toBeNull();
  });

  it('says there are no images, offering the interactive version, and shows the no-access state', async () => {
    const first = await open({ ...MANIFEST, screens: [] });
    expect(byTestId('viewer-no-images')?.textContent).toContain('В этом дизайне нет картинок');
    expect(byTestId('viewer-no-images')?.querySelector('button')?.textContent?.trim()).toBe('Открыть интерактивную версию');
    expect(byTestId('viewer-position')).toBeNull();
    first.ref.close();
    await settle();

    await open({ status: 404 }, 278);
    expect(byTestId('viewer-no-access')?.textContent).toContain('Нет доступа к файлам дизайна');
    expect(byTestId('viewer-no-access')?.getAttribute('role')).toBe('alert');
  });

  it('shows "this screen did not load" with Retry when the image fails, and asks again on Retry', async () => {
    await open();
    byTestId<HTMLImageElement>('viewer-screen')?.dispatchEvent(new Event('error'));
    await settle();
    expect(byTestId('viewer-screen-failed')?.textContent).toContain('Этот экран не загрузился');
    expect(byTestId('viewer-zoom')).toBeNull();
    (byTestId('viewer-screen-failed')?.querySelector('button') as HTMLButtonElement).click();
    await settle();
    const img = byTestId<HTMLImageElement>('viewer-screen');
    expect(img?.getAttribute('src')).toContain('&attempt=1');
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const { opener } = await open();
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await settle();
    expect(overlay().querySelector('tc-sheet-container')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
