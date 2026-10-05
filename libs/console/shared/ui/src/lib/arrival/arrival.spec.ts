import { ARRIVAL_CLASS, markArrival, prefersReducedMotion } from './arrival';

function setUp(): { card: HTMLElement; title: HTMLElement; outside: HTMLButtonElement; scroll: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = `
    <article id="card"><h2 id="title" tabindex="-1">#42</h2><button id="inside" type="button">Go</button></article>
    <button id="outside" type="button">Elsewhere</button>
  `;
  const card = document.getElementById('card') as HTMLElement;
  const scroll = vi.fn();
  card.scrollIntoView = scroll;
  return {
    card,
    title: document.getElementById('title') as HTMLElement,
    outside: document.getElementById('outside') as HTMLButtonElement,
    scroll,
  };
}

describe('markArrival', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-motion');
  });

  it('scrolls the element to the middle, rings it and focuses the target', () => {
    const { card, title, scroll } = setUp();

    markArrival(card, title);

    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(card.classList).toContain(ARRIVAL_CLASS);
    expect(document.activeElement).toBe(title);
  });

  it('jumps instead of gliding under reduced motion', () => {
    const { card, scroll } = setUp();
    document.documentElement.setAttribute('data-motion', 'reduce');

    markArrival(card);

    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
  });

  it('keeps the ring while focus moves inside and drops it when focus leaves', () => {
    const { card, title, outside } = setUp();
    markArrival(card, title);

    (document.getElementById('inside') as HTMLButtonElement).focus();
    expect(card.classList).toContain(ARRIVAL_CLASS);

    outside.focus();
    expect(card.classList).not.toContain(ARRIVAL_CLASS);
  });

  it('can be cleared by the caller', () => {
    const { card } = setUp();
    const arrival = markArrival(card);

    arrival.clear();

    expect(card.classList).not.toContain(ARRIVAL_CLASS);
  });
});

describe('prefersReducedMotion', () => {
  afterEach(() => document.documentElement.removeAttribute('data-motion'));

  it('follows a forced data-motion on <html> first', () => {
    document.documentElement.setAttribute('data-motion', 'reduce');
    expect(prefersReducedMotion(document)).toBe(true);
    document.documentElement.setAttribute('data-motion', 'full');
    expect(prefersReducedMotion(document)).toBe(false);
  });

  it('otherwise asks the media query', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    const view = document.defaultView as Window & { matchMedia?: unknown };
    const original = view.matchMedia;
    view.matchMedia = matchMedia;
    try {
      expect(prefersReducedMotion(document)).toBe(true);
      expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    } finally {
      view.matchMedia = original;
    }
  });
});
