import { describe, expect, test } from 'vitest';

import { createRenderer, RendererAbortError } from '../src';

describe('createRenderer', () => {
  test('validates a source before launching Chrome', async () => {
    const renderer = createRenderer();

    await expect(renderer.image({ source: { html: '  ' } })).rejects.toThrow(
      'html cannot be empty',
    );
  });

  test('requires a browser location for valid work', async () => {
    const renderer = createRenderer({ browser: { autoInstall: false } });

    await expect(
      renderer.evaluate({
        source: { html: '<h1>hello</h1>' },
        evaluate: async () => 'hello',
      }),
    ).rejects.toThrow('autoInstall is disabled');
  });

  test('cannot be reused after it is closed', async () => {
    const renderer = createRenderer();
    await renderer.close();

    await expect(
      renderer.evaluate({
        source: { html: '<h1>hello</h1>' },
        evaluate: async () => 'hello',
      }),
    ).rejects.toThrow('Renderer is closed');
  });

  test('normalizes caller cancellation to a structured error', async () => {
    const renderer = createRenderer();
    const controller = new AbortController();
    controller.abort();

    await expect(
      renderer.evaluate({
        source: { html: '<h1>hello</h1>' },
        signal: controller.signal,
        evaluate: async () => 'hello',
      }),
    ).rejects.toMatchObject({
      code: 'RENDERER_ABORTED',
      name: RendererAbortError.name,
    });
  });

  test('validates queue and timeout limits', () => {
    expect(() => createRenderer({ maxConcurrency: 0 })).toThrow(
      'maxConcurrency',
    );
    expect(() => createRenderer({ maxQueueSize: -1 })).toThrow('maxQueueSize');
    expect(() => createRenderer({ taskTimeout: 1.5 })).toThrow('taskTimeout');
    expect(() => createRenderer({ retry: { maxAttempts: 0 } })).toThrow(
      'retry.maxAttempts',
    );
    expect(() =>
      createRenderer({
        connectOptions: { browserWSEndpoint: 'ws://127.0.0.1' },
        executablePath: '/chrome',
      }),
    ).toThrow('connectOptions cannot be combined');
  });
});
