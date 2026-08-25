import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

import { launch as launchBrowser } from 'puppeteer-core';
import { describe, expect, test } from 'vitest';

import {
  createRenderer,
  installCompatibleChrome,
  RendererClosedError,
  RendererSecurityError,
  RendererTimeoutError,
  type RendererEventType,
  type RendererOptions,
} from '../src';

const chromeCandidates = [
  process.env.PPTR_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((value): value is string => Boolean(value));

const executablePath =
  process.env.PPTR_FORCE_MANAGED === 'true'
    ? undefined
    : chromeCandidates.find(existsSync);
const autoInstall = process.env.PPTR_AUTO_INSTALL === 'true';
const describeWithChrome =
  executablePath || autoInstall ? describe : describe.skip;
const rendererOptions: RendererOptions = executablePath
  ? { executablePath }
  : {
      browser: {
        autoInstall: true,
        cacheDir: process.env.PPTR_CACHE_DIR,
      },
    };

const getTestExecutablePath = async (): Promise<string> =>
  executablePath ??
  (
    await installCompatibleChrome({
      cacheDir: process.env.PPTR_CACHE_DIR,
    })
  ).executablePath;

describeWithChrome('renderer with Chrome', () => {
  test('renders isolated concurrent jobs and remains usable after an error', async () => {
    const renderer = createRenderer(rendererOptions);

    try {
      const [title, count] = await Promise.all([
        renderer.evaluate({
          source: { html: '<title>First</title>' },
          evaluate: page => page.title(),
        }),
        renderer.evaluate({
          source: { html: '<main data-count="2"></main>' },
          evaluate: page =>
            page.$eval('main', element => Number(element.dataset.count)),
        }),
      ]);

      expect(title).toBe('First');
      expect(count).toBe(2);

      await expect(
        renderer.evaluate({
          source: { html: '<main>failure</main>' },
          evaluate: async () => {
            throw new Error('expected failure');
          },
        }),
      ).rejects.toThrow('expected failure');

      const png = await renderer.image({
        source: {
          html: '<main style="width:20px;height:20px;background:#d33"></main>',
        },
        viewport: { width: 120, height: 80 },
        afterNavigate: page =>
          page.evaluate(() => {
            setTimeout(() => {
              document.querySelector('main')?.setAttribute('data-ready', '');
            }, 10);
          }),
        wait: {
          fonts: true,
          selector: 'main[data-ready]',
          selectorOptions: { visible: true },
        },
      });

      expect(Array.from(png.slice(0, 8))).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);

      const pdf = await renderer.pdf({
        source: { html: '<h1>pptr-helper</h1>' },
        output: { format: 'A4', printBackground: true },
      });

      expect(new TextDecoder().decode(pdf.slice(0, 4))).toBe('%PDF');
    } finally {
      await renderer.close();
    }
  }, 30_000);

  test('applies deterministic time, locale, media, image, and font settings', async () => {
    const renderer = createRenderer(rendererOptions);

    try {
      const environment = await renderer.evaluate({
        source: {
          html: `
            <style>@keyframes fade { from { opacity: 0 } to { opacity: 1 } }</style>
            <img alt="pixel" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'></svg>">
          `,
        },
        deterministic: {
          now: '2024-01-02T03:04:05.000Z',
          scroll: false,
        },
        evaluate: page =>
          page.evaluate(() => ({
            colorScheme: matchMedia('(prefers-color-scheme: light)').matches,
            dateCall: Date.parse(Date()),
            dateConstruct: new Date().toISOString(),
            locale: navigator.language,
            now: Date.now(),
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)')
              .matches,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          })),
      });

      expect(environment).toEqual({
        colorScheme: true,
        dateCall: Date.parse('2024-01-02T03:04:05.000Z'),
        dateConstruct: '2024-01-02T03:04:05.000Z',
        locale: 'en-US',
        now: Date.parse('2024-01-02T03:04:05.000Z'),
        reducedMotion: true,
        timezone: 'UTC',
      });
    } finally {
      await renderer.close();
    }
  }, 30_000);

  test('applies headers and cookies to URL jobs', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          cookie: request.headers.cookie,
          header: request.headers['x-render-test'],
        }),
      );
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to create test server');
    }
    const url = `http://127.0.0.1:${address.port}`;
    const renderer = createRenderer(rendererOptions);

    try {
      const request = await renderer.evaluate({
        source: { url },
        headers: { 'x-render-test': 'header-value' },
        cookies: [
          {
            domain: '127.0.0.1',
            name: 'session',
            path: '/',
            value: 'cookie-value',
          },
        ],
        evaluate: page =>
          page.evaluate(() => JSON.parse(document.body.innerText) as unknown),
      });

      expect(request).toEqual({
        cookie: 'session=cookie-value',
        header: 'header-value',
      });
    } finally {
      await renderer.close();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  test('times out tasks, recovers, and drains active work on close', async () => {
    const renderer = createRenderer({
      ...rendererOptions,
      maxConcurrency: 1,
      taskTimeout: 5_000,
    });

    await expect(
      renderer.evaluate({
        source: { html: '<main>timeout</main>' },
        timeout: 50,
        evaluate: page =>
          page.evaluate(
            () => new Promise(resolve => setTimeout(resolve, 1_000)),
          ),
      }),
    ).rejects.toBeInstanceOf(RendererTimeoutError);

    await expect(
      renderer.evaluate({
        source: { html: '<main>recovered</main>' },
        evaluate: page => page.$eval('main', element => element.textContent),
      }),
    ).resolves.toBe('recovered');

    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const activeTask = renderer.evaluate({
      source: { html: '<main>drain</main>' },
      afterNavigate: () => gate,
      evaluate: async () => 'drained',
    });
    const closing = renderer.close();

    expect(renderer.stats.closing).toBe(true);
    await expect(
      renderer.evaluate({
        source: { html: '<main>new</main>' },
        evaluate: async () => 'new',
      }),
    ).rejects.toBeInstanceOf(RendererClosedError);

    release();
    await expect(activeTask).resolves.toBe('drained');
    await closing;
  }, 30_000);

  test('force close aborts active work', async () => {
    const renderer = createRenderer({
      ...rendererOptions,
      maxConcurrency: 1,
    });
    const activeTask = renderer.evaluate({
      source: { html: '<main>force close</main>' },
      afterNavigate: page =>
        page.evaluate(
          () => new Promise<void>(resolve => setTimeout(resolve, 5_000)),
        ),
      evaluate: async () => 'unreachable',
    });

    const closing = renderer.close({ force: true });
    await expect(activeTask).rejects.toBeInstanceOf(RendererClosedError);
    await closing;
  }, 30_000);

  test('returns metadata, captures an element, retries, and emits events', async () => {
    const events: RendererEventType[] = [];
    const renderer = createRenderer({
      ...rendererOptions,
      retry: { maxAttempts: 2, delay: 0 },
      onEvent: event => {
        events.push(event.type);
      },
    });
    let evaluations = 0;

    try {
      const image = await renderer.imageResult({
        source: {
          html: '<main style="width:24px;height:12px;background:#d33"></main>',
        },
        selector: 'main',
        taskId: 'element-shot',
        output: { encoding: 'base64' },
      });
      expect(typeof image.data).toBe('string');
      expect(image.metadata).toMatchObject({
        attempts: 1,
        finalUrl: 'about:blank',
        taskId: 'element-shot',
      });
      expect(image.metadata.totalDuration).toBeGreaterThanOrEqual(0);

      const retried = await renderer.evaluateResult({
        source: { html: '<main>retry succeeded</main>' },
        evaluate: page => {
          evaluations += 1;
          if (evaluations === 1) {
            throw new Error('transient failure');
          }
          return page.$eval('main', element => element.textContent);
        },
      });
      expect(retried.data).toBe('retry succeeded');
      expect(retried.metadata.attempts).toBe(2);
      expect(events).toContain('task.retry');
      expect(renderer.stats.succeeded).toBe(2);
    } finally {
      await renderer.close();
    }
  }, 30_000);

  test('controls requests and reports partial batch failures', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/') {
        response.setHeader('content-type', 'text/html');
        response.end(
          '<main>network</main><img src="/blocked.png"><script src="/allowed.js"></script>',
        );
        return;
      }
      response.setHeader(
        'content-type',
        request.url?.endsWith('.js') ? 'text/javascript' : 'image/png',
      );
      response.end(
        request.url?.endsWith('.js')
          ? 'document.body.dataset.loaded = "yes"'
          : 'not-an-image',
      );
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to create test server');
    }
    const renderer = createRenderer(rendererOptions);

    try {
      const networkResult = await renderer.evaluateResult({
        source: { url: `http://127.0.0.1:${address.port}` },
        network: { blockedResourceTypes: ['image'] },
        wait: { networkIdle: true },
        evaluate: page => page.evaluate(() => document.body.dataset.loaded),
      });
      expect(networkResult.data).toBe('yes');
      expect(networkResult.metadata.statusCode).toBe(200);
      expect(networkResult.metadata.network.requests).toBeGreaterThanOrEqual(3);
      expect(requests).not.toContain('/blocked.png');

      const batch = await renderer.batch(
        [
          {
            id: 'success',
            type: 'evaluate',
            options: {
              source: { html: '<main>ok</main>' },
              evaluate: page =>
                page.$eval('main', element => element.textContent),
            },
          },
          {
            id: 'failure',
            type: 'evaluate',
            options: {
              source: { html: '<main>failure</main>' },
              evaluate: async () => {
                throw new Error('batch failure');
              },
            },
          },
        ],
        { concurrency: 1 },
      );
      expect(batch[0]).toMatchObject({ id: 'success', status: 'fulfilled' });
      expect(batch[1]).toMatchObject({ id: 'failure', status: 'rejected' });
    } finally {
      await renderer.close();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  test('enforces security budgets with structured errors', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<img src="/one"><img src="/two"><script src="/large"></script>',
      );
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to create test server');
    }
    const renderer = createRenderer({
      ...rendererOptions,
      security: { allowPrivateNetwork: true, maxRequests: 2 },
    });
    const byteLimitedRenderer = createRenderer({
      ...rendererOptions,
      security: {
        allowPrivateNetwork: true,
        maxTotalResponseBytes: 10,
      },
    });

    try {
      await expect(
        renderer.evaluate({
          source: { url: `http://127.0.0.1:${address.port}` },
          wait: { networkIdle: true },
          evaluate: async () => 'unreachable',
        }),
      ).rejects.toBeInstanceOf(RendererSecurityError);
      await expect(
        byteLimitedRenderer.evaluate({
          source: { url: `http://127.0.0.1:${address.port}` },
          wait: { networkIdle: true },
          evaluate: async () => 'unreachable',
        }),
      ).rejects.toBeInstanceOf(RendererSecurityError);
    } finally {
      await renderer.close();
      await byteLimitedRenderer.close();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  test('launches with default private-network guard patterns', async () => {
    const renderer = createRenderer({ ...rendererOptions, security: {} });

    try {
      await expect(
        renderer.evaluate({
          source: { html: '<main>guarded</main>' },
          evaluate: page => page.$eval('main', element => element.textContent),
        }),
      ).resolves.toBe('guarded');
    } finally {
      await renderer.close();
    }
  }, 30_000);

  test('disconnects from a remote browser without closing it', async () => {
    const remoteBrowser = await launchBrowser({
      executablePath: await getTestExecutablePath(),
      headless: true,
    });
    const renderer = createRenderer({
      connectOptions: { browserWSEndpoint: remoteBrowser.wsEndpoint() },
    });

    try {
      await expect(
        renderer.evaluate({
          source: { html: '<title>remote</title>' },
          evaluate: page => page.title(),
        }),
      ).resolves.toBe('remote');
      await renderer.close();
      expect(remoteBrowser.connected).toBe(true);
      await expect(remoteBrowser.version()).resolves.toContain('Chrome');
    } finally {
      await renderer.close();
      await remoteBrowser.close();
    }
  }, 30_000);
});
