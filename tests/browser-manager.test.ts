import { describe, expect, test } from 'vitest';

import {
  COMPATIBLE_CHROME_REVISION,
  getBrowserCacheDir,
} from '../src/browser/managed-browser';

describe('managed browser metadata', () => {
  test('exposes Puppeteer matching Chrome revision', () => {
    expect(COMPATIBLE_CHROME_REVISION).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  test('respects an explicit cache directory', () => {
    expect(getBrowserCacheDir('/tmp/pptr-helper-browser')).toBe(
      '/tmp/pptr-helper-browser',
    );
  });
});
