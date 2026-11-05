import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ItemsApi, itemRouteOf, shownStatusOf } from '@console/entities/item';
import { NetworkStatus } from '@console/shared/api';
import { TranslocoPipe } from '@console/shared/i18n';
import { Icon } from '@console/shared/ui';
import type { ItemSummaryDto } from '@shared/contracts';
import { findQueryOf, githubIssueUrl, matchesOf, type FindProject, type FindQuery } from './find-query';

/** Results update after typing pauses this long, never on every key (#409 §5). */
export const FIND_DEBOUNCE_MS = 300;
const SHOWN_MAX = 50;

type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching' }
  | { readonly kind: 'found'; readonly items: readonly ItemSummaryDto[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'elsewhere'; readonly project: FindProject; readonly number: number }
  | { readonly kind: 'unknown-link' }
  | { readonly kind: 'failed' };

/**
 * Find a task (#409 §2.4): a `search` landmark over the project's open and closed tasks — a number (`142`, `#142`,
 * `TC-142`), a pasted GitHub issue link (numbers are kept, so #142 there is TC-142 here) or title words. Results
 * update politely after a 300 ms pause; Enter on an exact number opens the task. A link to another project offers it
 * there (or on GitHub when that project has not moved yet). Offline, the field still works on nothing and says so.
 */
@Component({
  selector: 'tc-find-item',
  imports: [Icon, RouterLink, TranslocoPipe],
  templateUrl: './find-item.html',
  styleUrl: './find-item.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FindItem implements OnInit {
  private readonly api = inject(ItemsApi);
  private readonly router = inject(Router);
  private readonly network = inject(NetworkStatus);
  private readonly injector = inject(Injector);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  readonly here = input.required<FindProject>();
  readonly projects = input<readonly FindProject[]>([]);
  readonly initialQuery = input('');

  protected readonly text = signal('');
  protected readonly outcome = signal<Outcome>({ kind: 'idle' });
  protected readonly isOffline = computed(() => !this.network.online());
  protected readonly shown = computed(() => {
    const outcome = this.outcome();
    return outcome.kind === 'found' ? outcome.items.slice(0, SHOWN_MAX) : [];
  });
  private all: ItemSummaryDto[] | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private token = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.timer !== null) {
        clearTimeout(this.timer);
      }
    });
  }

  ngOnInit(): void {
    this.text.set(this.initialQuery());
    if (this.initialQuery() !== '') {
      void this.search(this.initialQuery());
    }
    afterNextRender(() => this.field().nativeElement.focus(), { injector: this.injector });
  }

  protected onInput(value: string): void {
    this.text.set(value);
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.search(value), FIND_DEBOUNCE_MS);
  }

  /** Enter on an exact number opens it directly. */
  protected async onEnter(event: Event): Promise<void> {
    event.preventDefault();
    const query = this.queryOf(this.text());
    if (query.kind === 'number') {
      await this.open(query.number);
      return;
    }
    await this.search(this.text());
  }

  protected routeOf(item: ItemSummaryDto): string[] {
    return itemRouteOf(this.here().slug, item.number);
  }

  protected routeElsewhere(project: FindProject, number: number): string[] {
    return itemRouteOf(project.slug, number);
  }

  protected githubOf(project: FindProject, number: number): string | null {
    return githubIssueUrl(project, number);
  }

  protected statusOf(item: ItemSummaryDto): string {
    return shownStatusOf(item);
  }

  private queryOf(text: string): FindQuery {
    return findQueryOf(text, this.here(), this.projects());
  }

  private async open(number: number): Promise<void> {
    await this.router.navigate(itemRouteOf(this.here().slug, number));
  }

  private async search(text: string): Promise<void> {
    const token = ++this.token;
    const query = this.queryOf(text);
    if (this.isOffline()) {
      this.outcome.set({ kind: 'failed' });
      return;
    }
    switch (query.kind) {
      case 'empty':
        this.outcome.set({ kind: 'idle' });
        return;
      case 'elsewhere':
        this.outcome.set({ kind: 'elsewhere', project: query.project, number: query.number });
        return;
      case 'unknown-link':
        this.outcome.set({ kind: 'unknown-link' });
        return;
      case 'number': {
        this.outcome.set({ kind: 'searching' });
        const read = await this.api.item(this.here().slug, query.number);
        if (token !== this.token) {
          return;
        }
        if (read.ok) {
          this.outcome.set({ kind: 'found', items: [read.value] });
        } else {
          this.outcome.set(read.reason === 'not-found' ? { kind: 'none' } : { kind: 'failed' });
        }
        return;
      }
      case 'words': {
        this.outcome.set({ kind: 'searching' });
        if (this.all === null) {
          const read = await this.api.items(this.here().slug, { state: 'all' });
          if (!read.ok) {
            if (token === this.token) {
              this.outcome.set({ kind: 'failed' });
            }
            return;
          }
          this.all = read.value;
        }
        if (token !== this.token) {
          return;
        }
        const items = matchesOf(this.all, query.words);
        this.outcome.set(items.length === 0 ? { kind: 'none' } : { kind: 'found', items });
        return;
      }
    }
  }

  /** The page's h1, for the route's focus on arrival. */
  focusHeading(): void {
    this.heading().nativeElement.focus();
  }
}
