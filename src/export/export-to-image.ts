import { type ScreenshotOptions } from 'puppeteer-core';
import {
  type BasicActionArgs,
  checkBasicActionArgs,
  getBrowserPage,
} from '../basic';

export interface ExportToImageArgs extends BasicActionArgs {
  /** Image type, default png */
  type?: 'webp' | 'jpeg' | 'png';
  /** Other image generation configuration items */
  screenshotOptions?: ScreenshotOptions;
}

/** @deprecated Use renderer.image(). */
export const exportToImage = async ({
  url = '',
  savePath = '',
  type = 'png',
  userAgent,
  screenshotOptions,
  viewport,
  pageFunction,
  navigationOptions,
}: ExportToImageArgs): Promise<void> => {
  checkBasicActionArgs({ url, savePath });

  const page = await getBrowserPage({
    url,
    userAgent,
    viewport,
    pageFunction,
    navigationOptions,
  });

  const imgOptions = {
    type,
    path: savePath,
    fullPage: true,
    ...screenshotOptions,
  };

  try {
    await page.screenshot(imgOptions);
  } finally {
    await page.close();
  }
};
