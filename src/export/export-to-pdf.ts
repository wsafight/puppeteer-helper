import { type PDFOptions } from 'puppeteer-core';
import {
  type BasicActionArgs,
  checkBasicActionArgs,
  getBrowserPage,
} from '../basic';

export interface ExportToPdfArgs extends BasicActionArgs {
  pdfOptions?: PDFOptions;
}

/** @deprecated Use renderer.pdf(). */
export const exportToPdf = async ({
  url = '',
  savePath = '',
  viewport,
  pageFunction,
  userAgent,
  pdfOptions,
  navigationOptions,
}: ExportToPdfArgs) => {
  checkBasicActionArgs({ url, savePath });

  const page = await getBrowserPage({
    url,
    userAgent,
    viewport,
    pageFunction,
    navigationOptions,
  });

  const finalPdfOptions = {
    path: savePath,
    ...pdfOptions,
  };

  try {
    await page.pdf(finalPdfOptions);
  } finally {
    await page.close();
  }
};
