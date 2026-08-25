import { type Page } from 'puppeteer-core';

export interface AutoScrollOptions {
  delay?: number;
  distance?: number;
  maxSteps?: number;
}

export interface DeterministicRenderOptions {
  cache?: boolean;
  colorScheme?: 'dark' | 'light' | 'no-preference';
  disableAnimations?: boolean;
  locale?: string;
  mediaType?: 'print' | 'screen' | null;
  now?: Date | number | string;
  reducedMotion?: 'no-preference' | 'reduce';
  scroll?: boolean | AutoScrollOptions;
  timezone?: string;
  waitForFonts?: boolean;
  waitForImages?: boolean;
}

export type DeterministicPreset = boolean | DeterministicRenderOptions;

interface ResolvedDeterministicOptions {
  cache: boolean;
  colorScheme: 'dark' | 'light' | 'no-preference';
  disableAnimations: boolean;
  locale: string;
  mediaType: 'print' | 'screen' | null;
  now?: number;
  reducedMotion: 'no-preference' | 'reduce';
  scroll: false | Required<AutoScrollOptions>;
  timezone: string;
  waitForFonts: boolean;
  waitForImages: boolean;
}

const DEFAULT_SCROLL: Required<AutoScrollOptions> = {
  delay: 50,
  distance: 600,
  maxSteps: 200,
};

const parseNow = (now: Date | number | string | undefined) => {
  if (now === undefined) {
    return undefined;
  }
  const timestamp =
    now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error('deterministic.now must be a valid date or timestamp');
  }
  return timestamp;
};

export const resolveDeterministicOptions = (
  preset: DeterministicPreset | undefined,
): ResolvedDeterministicOptions | undefined => {
  if (!preset) {
    return undefined;
  }
  const options = preset === true ? {} : preset;
  const scroll = options.scroll ?? true;

  return {
    cache: options.cache ?? false,
    colorScheme: options.colorScheme ?? 'light',
    disableAnimations: options.disableAnimations ?? true,
    locale: options.locale ?? 'en-US',
    mediaType: options.mediaType ?? 'screen',
    now: parseNow(options.now),
    reducedMotion: options.reducedMotion ?? 'reduce',
    scroll:
      scroll === false
        ? false
        : {
            ...DEFAULT_SCROLL,
            ...(scroll === true ? {} : scroll),
          },
    timezone: options.timezone ?? 'UTC',
    waitForFonts: options.waitForFonts ?? true,
    waitForImages: options.waitForImages ?? true,
  };
};

export const getDeterministicHeaders = (
  options: ResolvedDeterministicOptions | undefined,
): Record<string, string> =>
  options ? { 'accept-language': options.locale } : {};

export const prepareDeterministicPage = async (
  page: Page,
  options: ResolvedDeterministicOptions | undefined,
): Promise<void> => {
  if (!options) {
    return;
  }

  await page.setCacheEnabled(options.cache);
  await page.emulateTimezone(options.timezone);
  await page.emulateMediaType(options.mediaType ?? undefined);
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: options.colorScheme },
    { name: 'prefers-reduced-motion', value: options.reducedMotion },
  ]);

  const session = await page.createCDPSession();
  await session.send('Emulation.setLocaleOverride', {
    locale: options.locale,
  });

  const localeScript = `(() => {
    const locale = ${JSON.stringify(options.locale)};
    Object.defineProperties(globalThis.navigator, {
      language: { configurable: true, get: () => locale },
      languages: { configurable: true, get: () => [locale] },
    });
  })()`;
  await page.evaluateOnNewDocument(localeScript);
  await page.evaluate(localeScript);

  if (options.now !== undefined) {
    const script = `(() => {
      const OriginalDate = globalThis.Date;
      const timestamp = ${JSON.stringify(options.now)};
      function FixedDate(...args) {
        if (new.target) {
          return Reflect.construct(
            OriginalDate,
            args.length === 0 ? [timestamp] : args,
            new.target,
          );
        }
        return new OriginalDate(timestamp).toString();
      }
      Object.setPrototypeOf(FixedDate, OriginalDate);
      FixedDate.prototype = OriginalDate.prototype;
      Object.defineProperty(FixedDate, 'now', { value: () => timestamp });
      globalThis.Date = FixedDate;
    })()`;
    await page.evaluateOnNewDocument(script);
    await page.evaluate(script);
  }
};

export const waitForDeterministicPage = async (
  page: Page,
  options: ResolvedDeterministicOptions | undefined,
): Promise<void> => {
  if (!options) {
    return;
  }

  if (options.disableAnimations) {
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-delay: 0s !important;
          animation-duration: 0s !important;
          caret-color: transparent !important;
          scroll-behavior: auto !important;
          transition-delay: 0s !important;
          transition-duration: 0s !important;
        }
      `,
    });
  }

  if (options.scroll) {
    await page.evaluate(async scroll => {
      window.scrollTo(0, 0);
      let previousHeight = 0;
      let stableCount = 0;

      for (let step = 0; step < scroll.maxSteps; step += 1) {
        const height = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
        );
        const reachedBottom = window.scrollY + window.innerHeight >= height;

        if (reachedBottom && height === previousHeight) {
          stableCount += 1;
          if (stableCount >= 2) {
            break;
          }
        } else {
          stableCount = 0;
        }

        previousHeight = height;
        window.scrollBy(0, scroll.distance);
        await new Promise(resolve => setTimeout(resolve, scroll.delay));
      }

      window.scrollTo(0, 0);
    }, options.scroll);
  }

  if (options.waitForImages) {
    await page.evaluate(async () => {
      await Promise.all(
        Array.from(document.images, async image => {
          if (!image.complete) {
            await new Promise<void>(resolve => {
              image.addEventListener('load', () => resolve(), { once: true });
              image.addEventListener('error', () => resolve(), { once: true });
            });
          }
          await image.decode?.().catch(() => undefined);
        }),
      );
    });
  }

  if (options.waitForFonts) {
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
  }
};
