import { access } from 'node:fs/promises';
import { launch, type Browser } from 'puppeteer-core';
import { getBrowserConfig } from './config';

/** singleton */
let finalBrowser: Browser | undefined;
let browserPromise: Promise<Browser> | undefined;

export const getBrowser = async (): Promise<Browser> => {
  // If a browser instance has already been created, return the instance
  if (finalBrowser?.connected) {
    return finalBrowser;
  }
  if (browserPromise) {
    return browserPromise;
  }

  const { executablePath, headless, launchArgs } = getBrowserConfig();

  // Check whether the browser path is correct
  try {
    await access(executablePath);
  } catch (cause) {
    throw new Error(`Chrome executable was not found at ${executablePath}`, {
      cause,
    });
  }

  const launchOptions = {
    headless,
    executablePath,
    args: launchArgs,
  };

  browserPromise = launch(launchOptions);
  try {
    finalBrowser = await browserPromise;
    return finalBrowser;
  } catch (cause) {
    throw new Error(`Failed to launch Chrome at ${executablePath}`, { cause });
  } finally {
    browserPromise = undefined;
  }
};

/** @deprecated Use renderer.close(). */
export const closeBrowser = async (): Promise<void> => {
  const browser =
    finalBrowser ?? (await browserPromise?.catch(() => undefined));
  finalBrowser = undefined;
  if (browser?.connected) {
    await browser.close();
  }
};
