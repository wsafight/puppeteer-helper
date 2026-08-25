import { describe, expect, test } from 'vitest';

import { RendererSecurityError } from '../src/errors';
import {
  assertNavigationAllowed,
  getBrowserSecurityOptions,
  isPrivateNetworkAddress,
  validateSecurityOptions,
} from '../src/network';

describe('renderer security', () => {
  test('recognizes private and public network addresses', () => {
    expect(isPrivateNetworkAddress('127.0.0.1')).toBe(true);
    expect(isPrivateNetworkAddress('10.1.2.3')).toBe(true);
    expect(isPrivateNetworkAddress('172.31.2.3')).toBe(true);
    expect(isPrivateNetworkAddress('192.168.1.1')).toBe(true);
    expect(isPrivateNetworkAddress('::1')).toBe(true);
    expect(isPrivateNetworkAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateNetworkAddress('::ffff:a00:1')).toBe(true);
    expect(isPrivateNetworkAddress('::ffff:5db8:d822')).toBe(false);
    expect(isPrivateNetworkAddress('93.184.216.34')).toBe(false);
    expect(isPrivateNetworkAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(
      false,
    );
  });

  test('validates navigation and mutually exclusive browser guards', () => {
    expect(() => assertNavigationAllowed('file:///etc/passwd', {})).toThrow(
      RendererSecurityError,
    );
    expect(() => assertNavigationAllowed('http://127.0.0.1', {})).toThrow(
      RendererSecurityError,
    );
    expect(() =>
      validateSecurityOptions({
        allowlist: ['*://example.com/*'],
        blocklist: ['*://example.com/private/*'],
      }),
    ).toThrow('cannot be combined');
  });

  test('adds private network patterns to an enabled security policy', () => {
    expect(getBrowserSecurityOptions({}).blocklist).toContain('*://127.*/*');
    expect(getBrowserSecurityOptions({ allowPrivateNetwork: true })).toEqual(
      {},
    );
    expect(
      getBrowserSecurityOptions({ allowlist: ['*://example.com/*'] }),
    ).toEqual({ allowlist: ['*://example.com/*'] });
  });
});
