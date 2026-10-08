import { BreakpointObserver } from '@angular/cdk/layout';
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  linkedSignal,
  signal,
  untracked,
  viewChild,
  type TemplateRef,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  DesignManifests,
  devicesOf,
  megabytesOf,
  screenSrcOf,
  screensFor,
  type DesignManifest,
  type DesignScreen,
} from '@console/entities/design';
import { EmbedOriginsApi } from '@console/entities/project';
import { TranslocoPipe } from '@console/shared/i18n';
import {
  BREAKPOINTS,
  Button,
  DIALOG_DATA,
  DialogRef,
  Frame,
  frameSrcOf,
  SheetFooter,
  StateBlock,
} from '@console/shared/ui';
import { DESIGN_IMAGE_MAX_BYTES, type DesignDevice } from '@shared/contracts';

export interface DesignViewerData {
  readonly slug: string;
  readonly issue: number;
  readonly title: string;
  readonly actions: TemplateRef<unknown> | null;
  /** The path of the screen to start on; `null` starts on the first screen of the device in hand. */
  readonly screen: string | null;
  readonly mode: ViewerMode;
}

export type ViewerMode = 'images' | 'grid' | 'interactive';

type OriginsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly origins: readonly string[] };

/** A horizontal touch move at least this long, and clearly more sideways than down, turns the page. */
const SWIPE_MIN_PX = 48;
/** A pointer that moved less than this between down and up is a tap. */
const TAP_MAX_PX = 8;

let nextViewerId = 0;

/**
 * The design viewer's content (#277, spec §2–§6), opened by `DesignViewer` in the kit's full-size shell. «Картинки»
 * shows one screen fitted to the stage, moved by the footer buttons, ←/→ or a swipe; a tap zooms it to full width
 * inside the stage, the one scroller. «Все экраны» is a grid of thumbnails; «Интерактивно» frames the HTML
 * wireframe only from one of the project's embed origins, in the kit Frame's strict profile, and says so otherwise.
 * Every image is a plain `<img>` from the api Worker's file route; nothing here builds markup from GitHub text.
 */
@Component({
  selector: 'tc-design-viewer-dialog',
  imports: [Button, Frame, NgTemplateOutlet, SheetFooter, StateBlock, TranslocoPipe],
  templateUrl: './design-viewer-dialog.html',
  styleUrl: './design-viewer-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-design-viewer' },
})
export class DesignViewerDialog {
  protected readonly data = inject<DesignViewerData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<void>>(DialogRef);
  private readonly manifests = inject(DesignManifests);
  private readonly embedOrigins = inject(EmbedOriginsApi);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly injector = inject(Injector);

  protected readonly id = `tc-design-viewer-${nextViewerId++}`;
  protected readonly maxMegabytes = megabytesOf(DESIGN_IMAGE_MAX_BYTES);
  protected readonly modes: readonly ViewerMode[] = ['images', 'grid', 'interactive'];
  protected readonly ownOrigin = this.document.location.origin;

  protected readonly manifestState = this.manifests.stateOf(this.data.slug, this.data.issue);
  protected readonly manifest = computed<DesignManifest | null>(() => {
    const state = this.manifestState();
    return state.kind === 'ready' ? state.manifest : null;
  });

  protected readonly mode = signal<ViewerMode>(this.data.mode);
  /** The device control's choice; `null` when the design names no device or one only. */
  protected readonly device = signal<DesignDevice | null>(null);
  protected readonly index = signal(0);
  protected readonly zoomed = signal(false);
  /** The commit the screens are read at; when it changes every image is new, so what loaded or failed is forgotten. */
  private readonly sha = computed(() => this.manifest()?.sha ?? null);
  /** Screens whose image arrived or failed, by path; a retry bumps the attempt so the browser asks again. */
  protected readonly loaded = linkedSignal<string | null, ReadonlySet<string>>({
    source: this.sha,
    computation: () => new Set(),
  });
  protected readonly failed = linkedSignal<string | null, ReadonlySet<string>>({
    source: this.sha,
    computation: () => new Set(),
  });
  protected readonly attempts = linkedSignal<string | null, ReadonlyMap<string, number>>({
    source: this.sha,
    computation: () => new Map(),
  });
  protected readonly origins = signal<OriginsState>({ kind: 'idle' });

  protected readonly devices = computed(() => {
    const manifest = this.manifest();
    return manifest === null ? [] : devicesOf(manifest);
  });
  protected readonly screens = computed<readonly DesignScreen[]>(() => {
    const manifest = this.manifest();
    return manifest === null ? [] : screensFor(manifest, this.device());
  });
  protected readonly current = computed<DesignScreen | null>(() => this.screens()[this.index()] ?? null);
  /** The listed screen the viewer was opened on; `null` when none was asked for or the list no longer has it. */
  private readonly startScreen = computed<DesignScreen | null>(() => {
    const path = this.data.screen;
    return path === null ? null : (this.manifest()?.screens.find((screen) => screen.path === path) ?? null);
  });
  protected readonly isFirst = computed(() => this.index() <= 0);
  protected readonly isLast = computed(() => this.index() >= this.screens().length - 1);
  /** The project's embed origins once read; empty until then, so nothing is framed early. */
  protected readonly allowedOrigins = computed<readonly string[]>(() => {
    const origins = this.origins();
    return origins.kind === 'ready' ? origins.origins : [];
  });
  /** The wireframe's frame source when the project allows that origin (#20 gate); `null` says "cannot be shown". */
  protected readonly frameSrc = computed(() => {
    const interactive = this.manifest()?.interactive ?? null;
    if (interactive === null || this.origins().kind !== 'ready') {
      return null;
    }
    return frameSrcOf(interactive.url, this.allowedOrigins(), this.ownOrigin);
  });
  protected readonly hasFooter = computed(
    () => this.data.actions !== null || (this.mode() === 'images' && this.screens().length > 0),
  );

  private readonly stage = viewChild<ElementRef<HTMLElement>>('stage');
  /** The stage's content is taller or wider than the stage (a state block in a short stage, a tiny screen). */
  private readonly stageOverflows = signal(false);
  /**
   * A stage that scrolls must be reachable and named (axe `scrollable-region-focusable`): always when zoomed, and
   * whenever its content overflows anyway, so a fitted screen never leaves a scroller the keyboard cannot reach.
   */
  protected readonly isStageScrollable = computed(() => this.zoomed() || this.stageOverflows());

  private swipeStart: { x: number; y: number; isTouch: boolean } | null = null;

  constructor() {
    // Opening reads the list again: the team may have pushed to the design since a row loaded it.
    void this.manifests.reload(this.data.slug, this.data.issue);
    // Both devices drawn: start on the device of the screen asked for, else on the one the owner is holding.
    effect(() => {
      const devices = this.devices();
      untracked(() => {
        if (devices.length === 2 && this.device() === null) {
          const start = this.startScreen();
          this.device.set(
            start?.device ?? (this.breakpoints.isMatched(BREAKPOINTS.phone) ? 'phone' : 'mac'),
          );
        }
      });
    });
    // The screen asked for, once its list is in; later reads of the list keep where the owner has gone since.
    let isStartPlaced = this.data.screen === null;
    effect(() => {
      const screens = this.screens();
      const start = this.startScreen();
      if (isStartPlaced || start === null || (this.devices().length === 2 && this.device() === null)) {
        return;
      }
      isStartPlaced = true;
      const index = screens.findIndex((screen) => screen.path === start.path);
      untracked(() => this.index.set(Math.max(index, 0)));
    });
    // The embed origins are asked for once, the first time the interactive mode is opened.
    effect(() => {
      if (this.mode() === 'interactive' && untracked(() => this.origins().kind === 'idle')) {
        untracked(() => void this.loadOrigins());
      }
    });
    this.watchStageOverflow();
    const onKey = (event: KeyboardEvent): void => this.onKey(event);
    this.document.addEventListener('keydown', onKey);
    inject(DestroyRef).onDestroy(() => this.document.removeEventListener('keydown', onKey));
  }

  protected setMode(mode: ViewerMode): void {
    this.mode.set(mode);
  }

  protected setDevice(device: DesignDevice): void {
    if (this.device() !== device) {
      this.device.set(device);
      this.index.set(0);
      this.zoomed.set(false);
    }
  }

  protected srcOf(screen: DesignScreen): string {
    const manifest = this.manifest();
    if (manifest === null) {
      return '';
    }
    const src = screenSrcOf(this.data.slug, manifest, screen);
    const attempt = this.attempts().get(screen.path) ?? 0;
    return attempt === 0 ? src : `${src}&attempt=${attempt}`;
  }

  protected isLoaded(screen: DesignScreen): boolean {
    return this.loaded().has(screen.path);
  }

  protected hasFailed(screen: DesignScreen): boolean {
    return this.failed().has(screen.path);
  }

  protected onLoaded(screen: DesignScreen): void {
    this.loaded.update((paths) => new Set(paths).add(screen.path));
  }

  /**
   * An image did not arrive. Most often the design moved to another commit and the Worker answers 404 for the old
   * one: the list is read again once per commit, and a new commit renders every screen anew. Only when the list
   * did not change (or was already refetched for this commit) is the screen shown as failed.
   */
  protected async onFailed(screen: DesignScreen): Promise<void> {
    const sha = this.sha();
    if (sha !== null && (await this.manifests.recover(this.data.slug, this.data.issue, sha)) && this.sha() !== sha) {
      return;
    }
    if (this.sha() === sha) {
      this.failed.update((paths) => new Set(paths).add(screen.path));
    }
  }

  /** «Повторить»: the list again (the commit may have moved), then the image again. */
  protected retry(screen: DesignScreen): void {
    this.failed.update((paths) => {
      const next = new Set(paths);
      next.delete(screen.path);
      return next;
    });
    this.attempts.update((map) => new Map(map).set(screen.path, (map.get(screen.path) ?? 0) + 1));
    void this.manifests.reload(this.data.slug, this.data.issue);
  }

  protected megabytes(screen: DesignScreen): number {
    return megabytesOf(screen.size);
  }

  protected prev(): void {
    this.goTo(this.index() - 1);
  }

  protected next(): void {
    this.goTo(this.index() + 1);
  }

  protected goTo(index: number): void {
    const last = this.screens().length - 1;
    const clamped = Math.max(0, Math.min(index, last));
    if (clamped !== this.index()) {
      this.index.set(clamped);
      this.zoomed.set(false);
    }
  }

  /** From the grid: show that screen in «Картинки», with the keyboard on «Вперёд» so it can keep going. */
  protected openScreen(index: number): void {
    this.goTo(index);
    this.mode.set('images');
    // The footer with «Вперёд» is rendered by the shell on the next change detection; focus it once it is there.
    afterNextRender(
      () => {
        const next = this.host.nativeElement
          .closest('tc-sheet-container')
          ?.querySelector<HTMLButtonElement>('[data-testid="viewer-next"]');
        next?.focus();
      },
      { injector: this.injector },
    );
  }

  protected toggleZoom(): void {
    this.zoomed.update((zoomed) => !zoomed);
  }

  protected reloadManifest(): void {
    void this.manifests.reload(this.data.slug, this.data.issue);
  }

  protected openSettings(): void {
    this.ref.close();
    void this.router.navigateByUrl('/settings');
  }

  protected onPointerDown(event: PointerEvent): void {
    this.swipeStart = { x: event.clientX, y: event.clientY, isTouch: event.pointerType === 'touch' };
  }

  /**
   * A tap on the screen itself zooms it (the toolbar toggle is the keyboard's way, spec §6); a sideways touch move
   * of at least `SWIPE_MIN_PX` turns the page, unless the screen is zoomed and the move scrolls it.
   */
  protected onPointerUp(event: PointerEvent): void {
    const start = this.swipeStart;
    this.swipeStart = null;
    if (start === null || this.mode() !== 'images') {
      return;
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const isTap = Math.abs(dx) < TAP_MAX_PX && Math.abs(dy) < TAP_MAX_PX;
    if (isTap) {
      if (event.target instanceof Element && event.target.closest('[data-testid="viewer-screen"]') !== null) {
        this.toggleZoom();
      }
      return;
    }
    if (!start.isTouch || this.zoomed() || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) {
      return;
    }
    if (dx < 0) {
      this.next();
    } else {
      this.prev();
    }
  }

  private onKey(event: KeyboardEvent): void {
    if (this.mode() !== 'images' || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    // Another dialog on top (a confirmation from the footer actions) owns the keyboard then.
    const dialog = target?.closest('[role="dialog"], [role="alertdialog"]') ?? null;
    if (dialog !== null && !dialog.contains(this.host.nativeElement)) {
      return;
    }
    if (target !== null && target.closest('input, textarea, select, [contenteditable="true"]') !== null) {
      return;
    }
    event.preventDefault();
    if (event.key === 'ArrowLeft') {
      this.prev();
    } else {
      this.next();
    }
  }

  /**
   * Keeps `stageOverflows` true while the stage's content does not fit it: the stage itself resizing (a taller
   * footer), its content resizing, or new content (another state, another screen). Without ResizeObserver (jsdom)
   * the stage stays as the zoom toggle sets it.
   */
  private watchStageOverflow(): void {
    const destroyRef = inject(DestroyRef);
    afterNextRender(
      () => {
        const stage = this.stage()?.nativeElement;
        const view = this.document.defaultView;
        if (stage === undefined || view === null || typeof view.ResizeObserver !== 'function') {
          return;
        }
        const measure = (): void =>
          this.stageOverflows.set(
            stage.scrollHeight > stage.clientHeight + 1 || stage.scrollWidth > stage.clientWidth + 1,
          );
        const resizes = new view.ResizeObserver(measure);
        const observeContent = (): void => {
          resizes.disconnect();
          resizes.observe(stage);
          for (const child of Array.from(stage.children)) {
            resizes.observe(child);
          }
          measure();
        };
        const mutations = new view.MutationObserver(observeContent);
        mutations.observe(stage, { childList: true, subtree: true });
        observeContent();
        destroyRef.onDestroy(() => {
          resizes.disconnect();
          mutations.disconnect();
        });
      },
      { injector: this.injector },
    );
  }

  private async loadOrigins(): Promise<void> {
    this.origins.set({ kind: 'loading' });
    try {
      this.origins.set({ kind: 'ready', origins: await this.embedOrigins.origins(this.data.slug) });
    } catch {
      // Unknown origins embed nothing: the viewer says the version cannot be shown and offers the link.
      this.origins.set({ kind: 'ready', origins: [] });
    }
  }
}
