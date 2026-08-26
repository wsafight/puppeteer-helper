import {
  KnownDevices,
  type Device,
  type PDFOptions,
  type ScreenshotOptions,
  type Viewport,
} from 'puppeteer-core';

export type DevicePresetName = 'desktop' | 'mobile' | 'tablet';
export type ImageOutputPresetName =
  'open-graph' | 'social-square' | 'social-story';
export type PdfOutputPresetName = 'invoice' | 'report';

export interface DeviceProfile {
  userAgent?: string;
  viewport: Viewport;
}

export interface ImageOutputPreset {
  output: ScreenshotOptions;
  viewport: Viewport;
}

export const DEVICE_PRESETS: Readonly<Record<DevicePresetName, DeviceProfile>> =
  {
    desktop: { viewport: { deviceScaleFactor: 1, height: 900, width: 1440 } },
    mobile: KnownDevices['iPhone 15 Pro'],
    tablet: KnownDevices['iPad Pro 11'],
  };

export const IMAGE_OUTPUT_PRESETS: Readonly<
  Record<ImageOutputPresetName, ImageOutputPreset>
> = {
  'open-graph': {
    output: { fullPage: false, type: 'png' },
    viewport: { deviceScaleFactor: 1, height: 630, width: 1200 },
  },
  'social-square': {
    output: { fullPage: false, type: 'png' },
    viewport: { deviceScaleFactor: 1, height: 1080, width: 1080 },
  },
  'social-story': {
    output: { fullPage: false, type: 'png' },
    viewport: { deviceScaleFactor: 1, height: 1920, width: 1080 },
  },
};

export const PDF_OUTPUT_PRESETS: Readonly<
  Record<PdfOutputPresetName, PDFOptions>
> = {
  invoice: {
    format: 'A4',
    margin: { bottom: '12mm', left: '12mm', right: '12mm', top: '12mm' },
    printBackground: true,
  },
  report: {
    format: 'letter',
    margin: { bottom: '20mm', left: '18mm', right: '18mm', top: '20mm' },
    printBackground: true,
  },
};

export const resolveDeviceProfile = (
  device: DevicePresetName | keyof typeof KnownDevices | Device | undefined,
): DeviceProfile | undefined => {
  if (!device) {
    return undefined;
  }
  if (typeof device !== 'string') {
    return device;
  }
  const preset = DEVICE_PRESETS[device as DevicePresetName];
  if (preset) {
    return preset;
  }
  const known = KnownDevices[device as keyof typeof KnownDevices];
  if (!known) {
    throw new Error(`Unknown device preset: ${device}`);
  }
  return known;
};
