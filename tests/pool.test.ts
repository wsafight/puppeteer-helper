import { describe, expect, test } from 'vitest';

import { RendererClosedError } from '../src/errors';
import { createRendererPool } from '../src/pool';

describe('renderer pool', () => {
  test('validates options, aggregates limits, and closes without launching', async () => {
    expect(() => createRendererPool({ size: 0 })).toThrow('size');
    expect(() =>
      createRendererPool({ maxTasksPerBrowser: -1, size: 1 }),
    ).toThrow('maxTasksPerBrowser');

    const pool = createRendererPool({
      renderer: { maxConcurrency: 2, maxQueueSize: 3 },
      size: 2,
    });
    expect(pool.stats).toMatchObject({
      maxConcurrency: 4,
      maxQueueSize: 6,
      recycling: 0,
      size: 2,
    });
    await pool.close();
    await expect(
      pool.evaluate({
        evaluate: async () => 'closed',
        source: { html: '<main>closed</main>' },
      }),
    ).rejects.toBeInstanceOf(RendererClosedError);
  });
});
