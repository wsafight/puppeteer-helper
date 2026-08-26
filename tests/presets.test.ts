import { describe, expect, test } from 'vitest';

import {
  DEVICE_PRESETS,
  IMAGE_OUTPUT_PRESETS,
  PDF_OUTPUT_PRESETS,
  resolveDeviceProfile,
} from '../src/presets';

describe('render presets', () => {
  test('resolves aliases, Puppeteer devices, and output templates', () => {
    expect(resolveDeviceProfile('desktop')).toBe(DEVICE_PRESETS.desktop);
    expect(resolveDeviceProfile('iPhone 15 Pro')?.viewport.isMobile).toBe(true);
    expect(() => resolveDeviceProfile('unknown' as 'mobile')).toThrow(
      'Unknown device preset',
    );
    expect(IMAGE_OUTPUT_PRESETS['open-graph']).toMatchObject({
      output: { fullPage: false, type: 'png' },
      viewport: { height: 630, width: 1200 },
    });
    expect(PDF_OUTPUT_PRESETS.invoice).toMatchObject({
      format: 'A4',
      printBackground: true,
    });
  });
});
