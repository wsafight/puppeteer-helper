import { type GoToOptions, type Page, type Viewport } from 'puppeteer-core';
import { getBrowser } from './browser/get-browser';
import { getDefaultViewport } from './constants';
import { invariant } from './utils';

export interface BasicActionArgs {
  /** The URL of the webpage that needs to be screenshot */
  url: string;
  /** Local save address */
  savePath: string;
  /** Without this configuration, many web pages do not support browsing. */
  userAgent?: string;
  /** callback function */
  pageFunction?: (page: Page) => Promise<void>;
  /** viewport */
  viewport?: Viewport;
  /** Puppeteer navigation options. */
  navigationOptions?: GoToOptions;
}

export const checkBasicActionArgs = ({ url, savePath }: BasicActionArgs) => {
  invariant(
    typeof url !== 'string' || !url,
    'url must be a string and cannot be empty',
  );
  invariant(
    typeof savePath !== 'string' || !savePath,
    'savePath must be a string and cannot be empty',
  );
};

export const getBrowserPage = async ({
  url,
  userAgent,
  viewport,
  pageFunction,
  navigationOptions,
}: Omit<BasicActionArgs, 'savePath'>): Promise<Page> => {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport(viewport ?? getDefaultViewport());
    if (userAgent) {
      await page.setUserAgent({ userAgent });
    }
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      ...navigationOptions,
    });

    if (pageFunction) {
      await pageFunction(page);
    }
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
};
