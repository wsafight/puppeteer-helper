import { type Page } from 'puppeteer-core';
import { type BasicActionArgs, getBrowserPage } from '../basic';
import { invariant } from '../utils';

export type GetEvalResultFromPage<T = unknown> = Omit<
  BasicActionArgs,
  'savePath'
> & {
  evalFunction: (page: Page) => Promise<T>;
};

/** @deprecated Use renderer.evaluate(). */
export const getEvalResult = async <T>({
  url = '',
  userAgent,
  viewport,
  pageFunction,
  evalFunction,
  navigationOptions,
}: GetEvalResultFromPage<T>): Promise<T> => {
  invariant(
    typeof url !== 'string' || !url,
    'url must be a string and cannot be empty',
  );

  const page = await getBrowserPage({
    url,
    userAgent,
    viewport,
    pageFunction,
    navigationOptions,
  });
  try {
    return await evalFunction(page);
  } finally {
    await page.close();
  }
};
