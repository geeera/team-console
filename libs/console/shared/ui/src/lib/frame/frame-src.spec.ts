import type { DomSanitizer } from '@angular/platform-browser';
import { externalHrefOf, FRAME_HOST_SUFFIXES, frameSrcOf, trustedFrameSrc } from './frame-src';

const STORYBOOK = 'https://team-console-storybook.pages.dev';
const STAGE = 'https://team-console-stage.geeera.workers.dev';
// The console the helper runs in; for team-console itself its own environments can appear in embedOrigins.
const OWN = 'https://team-console-dev.geeera.workers.dev';
const ALLOWED = [STORYBOOK, STAGE];

describe('frameSrcOf', () => {
  it.each([
    [`${STORYBOOK}/?path=/story/kit-card--default`, `${STORYBOOK}/?path=/story/kit-card--default`],
    [`${STORYBOOK}`, `${STORYBOOK}/`],
    [`${STAGE}/p/storify/questions#12`, `${STAGE}/p/storify/questions#12`],
    // The parser lowercases the host before the exact comparison.
    ['https://TEAM-console-storybook.PAGES.dev/x', `${STORYBOOK}/x`],
    [`${STORYBOOK}:443/x`, `${STORYBOOK}/x`],
  ])('accepts %s on an allowed origin', (candidate, expected) => {
    expect(frameSrcOf(candidate, ALLOWED, OWN)).toBe(expected);
  });

  it.each([
    // Not an allowed origin, however close it looks.
    ['another project on the same family', 'https://evil.pages.dev/'],
    ['a prefix of the allowed host', 'https://team-console-storybook.pages.dev.evil.example/'],
    ['the allowed host as a subdomain', 'https://x.team-console-storybook.pages.dev/'],
    ['the allowed origin inside the path', 'https://evil.pages.dev/https://team-console-storybook.pages.dev'],
    ['the allowed origin in the query', 'https://evil.pages.dev/?u=https://team-console-storybook.pages.dev'],
    ['credentials before an allowed-looking host', 'https://team-console-storybook.pages.dev@evil.pages.dev/'],
    ['credentials on the allowed host', 'https://user:pass@team-console-storybook.pages.dev/'],
    ['a username only', 'https://user@team-console-storybook.pages.dev/'],
    ['another port', 'https://team-console-storybook.pages.dev:8443/'],
    ['a trailing dot', 'https://team-console-storybook.pages.dev./'],
    // Not https.
    ['plain http', 'http://team-console-storybook.pages.dev/'],
    ['javascript:', 'javascript:alert(1)'],
    ['javascript: with the allowed origin in it', 'javascript://team-console-storybook.pages.dev/%0aalert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['blob:', `blob:${STORYBOOK}/1234`],
    ['about:blank', 'about:blank'],
    ['file:', 'file:///etc/passwd'],
    ['protocol-relative', '//team-console-storybook.pages.dev/'],
    ['a relative path', '/p/storify'],
    ['empty', ''],
    ['whitespace', '   '],
    // IP addresses and loopback.
    ['loopback IPv4', 'https://127.0.0.1/'],
    ['IPv4 in hex', 'https://0x7f.1/'],
    ['IPv4 as one number', 'https://2130706433/'],
    ['IPv6 loopback', 'https://[::1]/'],
    ['localhost', 'https://localhost/'],
    ['a .localhost name', 'https://storybook.localhost/'],
    ['a private address', 'https://10.0.0.1/'],
    // Outside the CSP's frame families.
    ['github.com', 'https://github.com/geeera/team-console'],
    ['the bare family domain', 'https://pages.dev/'],
    ['a look-alike family', 'https://evilpages.dev/'],
    ['punycode look-alike', 'https://xn--tam-console-storybook-xyz.pages.dev/'],
    ['a wildcard', 'https://*.pages.dev/'],
    ['an underscore host', 'https://team_console.pages.dev/'],
    ['backslashes', 'https:\\\\evil.example\\team-console-storybook.pages.dev'],
    ['a newline smuggled into the host', 'https://team-console-storybook.pages.dev%0a.evil.example/'],
    ['too long', `${STORYBOOK}/${'a'.repeat(2100)}`],
  ])('refuses %s', (_name, candidate) => {
    // Hostile entries in the allow-list itself must not open a door either.
    expect(frameSrcOf(candidate, [...ALLOWED, 'https://evil.example', 'https://127.0.0.1'], OWN)).toBeNull();
  });

  it('refuses an IP or loopback origin even when the allow-list names it', () => {
    expect(frameSrcOf('https://127.0.0.1/', ['https://127.0.0.1'], OWN)).toBeNull();
    expect(frameSrcOf('https://localhost/', ['https://localhost'], OWN)).toBeNull();
  });

  it('refuses an allowed origin outside the frame families, which the CSP would block silently', () => {
    expect(frameSrcOf('https://storify.example/x', ['https://storify.example'], OWN)).toBeNull();
  });

  it("refuses the console's own origin even when the allow-list names it (a same-origin frame lifts its sandbox)", () => {
    expect(frameSrcOf(`${OWN}/api/v1/me`, [...ALLOWED, OWN], OWN)).toBeNull();
    expect(frameSrcOf(`${STAGE}/p/storify`, ALLOWED, STAGE)).toBeNull();
    // The same URL is fine from another console, where it is cross-origin.
    expect(frameSrcOf(`${STAGE}/p/storify`, ALLOWED, OWN)).toBe(`${STAGE}/p/storify`);
  });

  it('refuses everything when nothing is allowed', () => {
    expect(frameSrcOf(`${STORYBOOK}/`, [], OWN)).toBeNull();
  });

  it('compares whole origins, never prefixes of an allow-list entry', () => {
    expect(frameSrcOf(`${STORYBOOK}/`, [`${STORYBOOK}/`], OWN)).toBeNull();
    expect(frameSrcOf(`${STORYBOOK}/`, ['https://team-console-storybook.pages'], OWN)).toBeNull();
  });

  it.each([null, undefined, 42, {}, ['https://team-console-storybook.pages.dev/']])(
    'refuses a non-string %s',
    (candidate) => {
      expect(frameSrcOf(candidate, ALLOWED, OWN)).toBeNull();
    },
  );

  it('keeps the CSP families of apps/console/public/_headers', () => {
    expect(FRAME_HOST_SUFFIXES).toEqual(['.pages.dev', '.workers.dev', '.github.io']);
  });
});

describe('trustedFrameSrc', () => {
  function sanitizerStub(): { sanitizer: DomSanitizer; calls: string[] } {
    const calls: string[] = [];
    const sanitizer = {
      bypassSecurityTrustResourceUrl: (value: string) => {
        calls.push(value);
        return { trusted: value };
      },
    } as unknown as DomSanitizer;
    return { sanitizer, calls };
  }

  it('marks only the checked value as trusted', () => {
    const { sanitizer, calls } = sanitizerStub();
    expect(trustedFrameSrc(sanitizer, 'https://TEAM-console-storybook.pages.dev/x', ALLOWED, OWN)).toEqual({
      trusted: `${STORYBOOK}/x`,
    });
    expect(calls).toEqual([`${STORYBOOK}/x`]);
  });

  it('never calls the bypass for a refused value', () => {
    const { sanitizer, calls } = sanitizerStub();
    expect(trustedFrameSrc(sanitizer, 'javascript:alert(1)', ALLOWED, OWN)).toBeNull();
    expect(trustedFrameSrc(sanitizer, 'https://evil.pages.dev/', ALLOWED, OWN)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('externalHrefOf', () => {
  it('links https and http pages', () => {
    expect(externalHrefOf('https://evil.pages.dev/x')).toBe('https://evil.pages.dev/x');
    expect(externalHrefOf('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/');
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', '/relative', '', 42])(
    'links nothing for %s',
    (candidate) => {
      expect(externalHrefOf(candidate)).toBeNull();
    },
  );
});
