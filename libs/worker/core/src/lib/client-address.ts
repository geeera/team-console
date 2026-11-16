/**
 * The unit a per-address rate limit counts (#696). An IPv4 address is one caller. An IPv6 caller is given a whole /64
 * (2^64 addresses), so it is counted by that prefix; an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is the IPv4
 * address it carries. `unknown` covers a missing, empty or malformed header: never a real client of the edge, but
 * named, so callers share one bucket for it instead of each spelling its own.
 */
export type RateLimitAddress =
  | { readonly kind: 'ipv4'; readonly key: string }
  | { readonly kind: 'ipv6-64'; readonly key: string }
  | { readonly kind: 'unknown' };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

/** `a.b.c.d` in canonical form, or `null`. */
function ipv4Of(text: string): string | null {
  const match = IPV4.exec(text);
  if (match === null) {
    return null;
  }
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets.join('.') : null;
}

/** The eight 16-bit groups of an IPv6 address (an embedded IPv4 tail included), or `null`. */
function hextetsOf(text: string): number[] | null {
  let rest = text.toLowerCase();
  const tail: number[] = [];
  const lastColon = rest.lastIndexOf(':');
  if (rest.slice(lastColon + 1).includes('.')) {
    const ipv4 = ipv4Of(rest.slice(lastColon + 1));
    if (ipv4 === null) {
      return null;
    }
    const [a = 0, b = 0, c = 0, d = 0] = ipv4.split('.').map(Number);
    tail.push(a * 256 + b, c * 256 + d);
    // `::1.2.3.4` keeps its `::`; `…:ffff:1.2.3.4` drops the single colon in front of the tail.
    rest = rest.slice(0, lastColon + 1);
    if (!rest.endsWith('::')) {
      rest = rest.slice(0, -1);
    }
  }
  const halves = rest.split('::');
  if (halves.length > 2) {
    return null;
  }
  const groupsOf = (half: string | undefined): string[] | null => {
    if (half === undefined || half === '') {
      return [];
    }
    const groups = half.split(':');
    return groups.every((group) => HEXTET.test(group)) ? groups : null;
  };
  const head = groupsOf(halves[0]);
  const back = groupsOf(halves[1]);
  if (head === null || back === null) {
    return null;
  }
  const given = head.length + back.length + tail.length;
  const compressed = halves.length === 2;
  if (compressed ? given > 7 : given !== 8) {
    return null;
  }
  const zeros = new Array<number>(8 - given).fill(0);
  return [...head.map((group) => parseInt(group, 16)), ...zeros, ...back.map((group) => parseInt(group, 16)), ...tail];
}

/** The rate-limit unit of a `CF-Connecting-IP` value (see `RateLimitAddress`). */
export function rateLimitAddressOf(header: string | null | undefined): RateLimitAddress {
  const text = header?.trim() ?? '';
  if (text === '') {
    return { kind: 'unknown' };
  }
  const ipv4 = ipv4Of(text);
  if (ipv4 !== null) {
    return { kind: 'ipv4', key: ipv4 };
  }
  // A zone id (`fe80::1%eth0`) is never on an edge header; it is malformed here, not a separate caller.
  const hextets = text.includes(':') && !text.includes('%') ? hextetsOf(text) : null;
  if (hextets === null) {
    return { kind: 'unknown' };
  }
  const isMappedIpv4 = hextets.slice(0, 5).every((group) => group === 0) && hextets[5] === 0xffff;
  if (isMappedIpv4) {
    const [high = 0, low = 0] = hextets.slice(6);
    return { kind: 'ipv4', key: [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.') };
  }
  return { kind: 'ipv6-64', key: `${hextets.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64` };
}
