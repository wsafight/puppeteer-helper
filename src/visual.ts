import { readFile, writeFile } from 'node:fs/promises';

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface PngComparisonOptions {
  actual: Uint8Array;
  baseline: string | Uint8Array;
  actualPath?: string;
  diffPath?: string;
  maxDiffPixels?: number;
  maxDiffRatio?: number;
  threshold?: number;
  includeAA?: boolean;
  diffMask?: boolean;
}

export interface PngComparisonResult {
  actual: Uint8Array;
  diff: Uint8Array;
  diffPixels: number;
  diffRatio: number;
  dimensionMismatch: boolean;
  height: number;
  passed: boolean;
  width: number;
}

const expandPng = (source: PNG, width: number, height: number): PNG => {
  if (source.width === width && source.height === height) {
    return source;
  }
  const expanded = new PNG({ height, width });
  expanded.data.fill(0);
  PNG.bitblt(source, expanded, 0, 0, source.width, source.height, 0, 0);
  return expanded;
};

export const comparePng = async ({
  actual,
  baseline,
  actualPath,
  diffPath,
  maxDiffPixels,
  maxDiffRatio = 0,
  threshold = 0.1,
  includeAA = false,
  diffMask = false,
}: PngComparisonOptions): Promise<PngComparisonResult> => {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('visual threshold must be between 0 and 1');
  }
  if (!Number.isFinite(maxDiffRatio) || maxDiffRatio < 0 || maxDiffRatio > 1) {
    throw new Error('maxDiffRatio must be between 0 and 1');
  }
  if (
    maxDiffPixels !== undefined &&
    (!Number.isSafeInteger(maxDiffPixels) || maxDiffPixels < 0)
  ) {
    throw new Error('maxDiffPixels must be a non-negative integer');
  }

  const baselineBytes =
    typeof baseline === 'string' ? await readFile(baseline) : baseline;
  const baselinePng = PNG.sync.read(Buffer.from(baselineBytes));
  const actualPng = PNG.sync.read(Buffer.from(actual));
  const width = Math.max(baselinePng.width, actualPng.width);
  const height = Math.max(baselinePng.height, actualPng.height);
  const normalizedBaseline = expandPng(baselinePng, width, height);
  const normalizedActual = expandPng(actualPng, width, height);
  const diffPng = new PNG({ height, width });
  const diffPixels = pixelmatch(
    normalizedBaseline.data,
    normalizedActual.data,
    diffPng.data,
    width,
    height,
    { diffMask, includeAA, threshold },
  );
  const pixelCount = width * height;
  const diffRatio = pixelCount === 0 ? 0 : diffPixels / pixelCount;
  const dimensionMismatch =
    baselinePng.width !== actualPng.width ||
    baselinePng.height !== actualPng.height;
  const passed =
    !dimensionMismatch &&
    diffRatio <= maxDiffRatio &&
    (maxDiffPixels === undefined || diffPixels <= maxDiffPixels);
  const diff = PNG.sync.write(diffPng);

  await Promise.all([
    actualPath ? writeFile(actualPath, actual) : undefined,
    diffPath ? writeFile(diffPath, diff) : undefined,
  ]);
  return {
    actual,
    diff,
    diffPixels,
    diffRatio,
    dimensionMismatch,
    height,
    passed,
    width,
  };
};
