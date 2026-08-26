import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';

import { comparePng } from '../src/visual';

const createPng = (width: number, height: number, red: number): Uint8Array => {
  const png = new PNG({ height, width });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = red;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
};

describe('PNG comparison', () => {
  test('compares pixels, dimensions, thresholds, and output files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pptr-helper-visual-'));
    const actualPath = join(directory, 'actual.png');
    const diffPath = join(directory, 'diff.png');
    const baseline = createPng(2, 2, 0);
    const changed = createPng(2, 2, 255);

    try {
      const identical = await comparePng({ actual: baseline, baseline });
      expect(identical).toMatchObject({
        diffPixels: 0,
        diffRatio: 0,
        dimensionMismatch: false,
        passed: true,
      });

      const different = await comparePng({
        actual: changed,
        actualPath,
        baseline,
        diffPath,
        maxDiffRatio: 0.5,
      });
      expect(different).toMatchObject({
        diffPixels: 4,
        diffRatio: 1,
        passed: false,
      });
      expect((await readFile(actualPath)).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
      expect((await readFile(diffPath)).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );

      const resized = await comparePng({
        actual: createPng(3, 2, 0),
        baseline,
        maxDiffRatio: 1,
      });
      expect(resized.dimensionMismatch).toBe(true);
      expect(resized.passed).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
