import { rateLimitAddressOf } from './client-address';

describe('rateLimitAddressOf', () => {
  it('counts an IPv4 address as itself, in canonical form', () => {
    expect(rateLimitAddressOf('203.0.113.9')).toEqual({ kind: 'ipv4', key: '203.0.113.9' });
    expect(rateLimitAddressOf(' 203.0.113.009 ')).toEqual({ kind: 'ipv4', key: '203.0.113.9' });
  });

  it('counts an IPv6 address by its /64, however it is written', () => {
    const key = { kind: 'ipv6-64', key: '2001:db8:1:2::/64' };
    expect(rateLimitAddressOf('2001:db8:1:2::1')).toEqual(key);
    expect(rateLimitAddressOf('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toEqual(key);
    expect(rateLimitAddressOf('2001:db8:1:2:a:b:1.2.3.4')).toEqual(key);
    expect(rateLimitAddressOf('2001:db8:1:3::1')).toEqual({ kind: 'ipv6-64', key: '2001:db8:1:3::/64' });
    expect(rateLimitAddressOf('::1')).toEqual({ kind: 'ipv6-64', key: '0:0:0:0::/64' });
    expect(rateLimitAddressOf('2001:db8::')).toEqual({ kind: 'ipv6-64', key: '2001:db8:0:0::/64' });
  });

  it('counts an IPv4-mapped IPv6 address as the IPv4 address it carries', () => {
    expect(rateLimitAddressOf('::ffff:203.0.113.9')).toEqual({ kind: 'ipv4', key: '203.0.113.9' });
    expect(rateLimitAddressOf('::FFFF:cb00:7109')).toEqual({ kind: 'ipv4', key: '203.0.113.9' });
    expect(rateLimitAddressOf('0:0:0:0:0:ffff:203.0.113.9')).toEqual({ kind: 'ipv4', key: '203.0.113.9' });
  });

  it('names a missing, empty or malformed header unknown', () => {
    for (const header of [
      undefined,
      null,
      '',
      '   ',
      'unknown',
      '256.0.0.1',
      '1.2.3',
      '1.2.3.4:80',
      '2001:db8::1::2',
      '2001:db8:1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7',
      '2001:db8:1:2:3:4:5:',
      ':2001:db8::1',
      '12345::1',
      'fe80::1%eth0',
      '::ffff:999.0.0.1',
      'g::1',
    ]) {
      expect(rateLimitAddressOf(header)).toEqual({ kind: 'unknown' });
    }
  });
});
