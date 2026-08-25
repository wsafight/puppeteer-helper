import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  type BrowserPlatform,
} from '@puppeteer/browsers';
import { PUPPETEER_REVISIONS } from 'puppeteer-core/internal/revisions.js';

export const COMPATIBLE_CHROME_REVISION = PUPPETEER_REVISIONS.chrome;

export interface BrowserInstallOptions {
  buildId?: string;
  cacheDir?: string;
  baseUrl?: string;
  downloadProgress?:
    'default' | ((downloadedBytes: number, totalBytes: number) => void);
}

export interface BrowserManagementOptions extends BrowserInstallOptions {
  /** Download a matching Chrome for Testing build when no path is provided. */
  autoInstall?: boolean;
}

export interface InstalledChrome {
  buildId: string;
  cacheDir: string;
  executablePath: string;
  platform: BrowserPlatform;
}

const pendingInstalls = new Map<string, Promise<InstalledChrome>>();

export const getBrowserCacheDir = (cacheDir?: string): string =>
  cacheDir ??
  process.env.PPTR_CACHE_DIR ??
  join(homedir(), '.cache', 'pptr-helper');

const getPlatform = (): BrowserPlatform => {
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error(`Unsupported browser platform: ${process.platform}`);
  }
  return platform;
};

const canExecute = async (executablePath: string): Promise<boolean> => {
  try {
    await access(executablePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const installCompatibleChrome = async (
  options: BrowserInstallOptions = {},
): Promise<InstalledChrome> => {
  const buildId = options.buildId ?? COMPATIBLE_CHROME_REVISION;
  const cacheDir = getBrowserCacheDir(options.cacheDir);
  const platform = getPlatform();
  const key = `${cacheDir}:${platform}:${buildId}`;
  const executablePath = computeExecutablePath({
    browser: Browser.CHROME,
    buildId,
    cacheDir,
    platform,
  });

  if (await canExecute(executablePath)) {
    return { buildId, cacheDir, executablePath, platform };
  }

  const existing = pendingInstalls.get(key);
  if (existing) {
    return existing;
  }

  const installing = (async (): Promise<InstalledChrome> => {
    const installed = await install({
      browser: Browser.CHROME,
      buildId,
      cacheDir,
      platform,
      baseUrl: options.baseUrl,
      downloadProgressCallback: options.downloadProgress,
    });
    return {
      buildId,
      cacheDir,
      executablePath: installed.executablePath,
      platform,
    };
  })();

  pendingInstalls.set(key, installing);
  try {
    return await installing;
  } finally {
    pendingInstalls.delete(key);
  }
};

export const resolveManagedBrowser = async (
  options: BrowserManagementOptions = {},
): Promise<InstalledChrome> => {
  if (options.autoInstall === false) {
    throw new Error(
      'A Chrome executablePath, PPTR_EXECUTABLE_PATH, or launchOptions.channel is required when autoInstall is disabled',
    );
  }
  return installCompatibleChrome(options);
};
