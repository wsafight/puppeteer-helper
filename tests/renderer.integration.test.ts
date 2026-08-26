import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launch as launchBrowser } from 'puppeteer-core';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';

import {
  createRenderer,
  createRendererPool,
  installCompatibleChrome,
  RendererClosedError,
  RendererSecurityError,
  RendererTimeoutError,
  type RendererEventType,
  type RendererOptions,
} from '../src';

const requestedExecutablePath =
  process.env.PPTR_EXECUTABLE_PATH?.trim() || undefined;
if (requestedExecutablePath && !existsSync(requestedExecutablePath)) {
  throw new Error(
    `PPTR_EXECUTABLE_PATH does not exist: ${requestedExecutablePath}`,
  );
}
const chromeCandidates = [
  requestedExecutablePath,
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

  test('compares rendered PNGs and ignores dynamic regions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pptr-helper-compare-'));
    const actualPath = join(directory, 'actual.png');
    const diffPath = join(directory, 'diff.png');
    const renderer = createRenderer(rendererOptions);

    try {
      const baseline = await renderer.image({
        source: {
          html: `
            <style>.dynamic { visibility: hidden }</style>
            <main style="width:40px;height:20px;background:red">
              <span class="dynamic">baseline</span>
            </main>
          `,
        },
        viewport: { height: 80, width: 120 },
      });
      const matching = await renderer.compare({
        baseline,
        ignoreSelectors: ['.dynamic'],
        source: {
          html: `
            <main style="width:40px;height:20px;background:red">
              <span class="dynamic">changed</span>
            </main>
          `,
        },
        viewport: { height: 80, width: 120 },
      });
      expect(matching).toMatchObject({
        diffPixels: 0,
        dimensionMismatch: false,
        passed: true,
      });

      const changed = await renderer.compare({
        actualPath,
        baseline,
        diffPath,
        source: {
          html: '<main style="width:40px;height:20px;background:blue"></main>',
        },
        viewport: { height: 80, width: 120 },
      });
      expect(changed.diffPixels).toBeGreaterThan(0);
      expect(changed.passed).toBe(false);
      expect((await readFile(actualPath)).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
      expect((await readFile(diffPath)).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
    } finally {
      await renderer.close();
      await rm(directory, { force: true, recursive: true });
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

  test('waits for delay, text, functions, and composed conditions', async () => {
    const renderer = createRenderer(rendererOptions);

    try {
      const result = await renderer.evaluate({
        afterNavigate: page =>
          page.evaluate(() => {
            setTimeout(() => {
              document.body.insertAdjacentHTML(
                'beforeend',
                '<span data-ready>Ready text</span>',
              );
              Object.assign(globalThis, { renderReady: true });
            }, 20);
          }),
        source: { html: '<main>Waiting</main>' },
        wait: {
          all: [
            { text: 'Ready text' },
            { function: 'globalThis.renderReady === true' },
          ],
          any: [{ selector: '[data-ready]' }, { text: 'never appears' }],
          delay: 5,
        },
        evaluate: page =>
          page.$eval('[data-ready]', element => element.textContent),
      });

      expect(result).toBe('Ready text');
    } finally {
      await renderer.close();
    }
  }, 30_000);

  test('applies device and image output presets', async () => {
    const renderer = createRenderer(rendererOptions);

    try {
      const device = await renderer.evaluate({
        device: 'mobile',
        source: {
          html: '<meta name="viewport" content="width=device-width"><main>mobile</main>',
        },
        evaluate: page =>
          page.evaluate(() => ({
            height: innerHeight,
            mobile: navigator.maxTouchPoints > 0,
            userAgent: navigator.userAgent,
            width: innerWidth,
          })),
      });
      expect(device).toMatchObject({ mobile: true, width: 393 });
      expect(device.userAgent).toContain('iPhone');

      const image = await renderer.image({
        preset: 'open-graph',
        source: { html: '<main>Open Graph</main>' },
      });
      expect(PNG.sync.read(Buffer.from(image))).toMatchObject({
        height: 630,
        width: 1200,
      });

      const pdf = await renderer.pdf({
        preset: 'invoice',
        source: { html: '<main>Invoice</main>' },
      });
      expect(new TextDecoder().decode(pdf.subarray(0, 4))).toBe('%PDF');
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

  test('restores and captures cookies and Web Storage', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`
        <main></main>
        <script>
          document.querySelector('main').dataset.local = localStorage.getItem('before');
          document.querySelector('main').dataset.session = sessionStorage.getItem('session');
          localStorage.setItem('after', 'captured');
        </script>
      `);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to create test server');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const renderer = createRenderer(rendererOptions);

    try {
      const result = await renderer.evaluateResult({
        captureStorageState: true,
        source: { url: origin },
        storageState: {
          cookies: [
            {
              domain: '127.0.0.1',
              name: 'restored',
              path: '/',
              value: 'cookie',
            },
          ],
          origins: [
            {
              localStorage: [{ name: 'before', value: 'restored' }],
              origin,
              sessionStorage: [{ name: 'session', value: 'restored' }],
            },
          ],
        },
        evaluate: page =>
          page.$eval('main', element => ({ ...element.dataset })),
      });

      expect(result.data).toMatchObject({
        local: 'restored',
        session: 'restored',
      });
      expect(result.metadata.storageState?.cookies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'restored', value: 'cookie' }),
        ]),
      );
      expect(result.metadata.storageState?.origins).toEqual([
        expect.objectContaining({
          localStorage: expect.arrayContaining([
            { name: 'after', value: 'captured' },
          ]),
          origin,
        }),
      ]);
    } finally {
      await renderer.close();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  test('captures page diagnostics, artifacts, and a failure screenshot', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/final' });
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`
        <main>diagnostics</main>
        <script>
          console.warn('diagnostic message');
          fetch('/failed').catch(() => document.body.dataset.ready = 'true');
        </script>
      `);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to create test server');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(join(tmpdir(), 'pptr-helper-diagnostics-'));
    const failurePath = join(directory, 'failure.png');
    const renderer = createRenderer(rendererOptions);

    try {
      const result = await renderer.evaluateResult({
        diagnostics: {
          console: true,
          failedRequests: true,
          har: true,
          html: true,
          mhtml: true,
          redirects: true,
        },
        network: {
          onRequest: request =>
            request.url().endsWith('/failed') ? 'abort' : 'continue',
        },
        source: { url: `${origin}/redirect` },
        wait: { selector: 'body[data-ready]' },
        evaluate: page => page.$eval('main', element => element.textContent),
      });

      expect(result.data).toBe('diagnostics');
      expect(result.metadata.diagnostics?.console).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'diagnostic message', type: 'warn' }),
        ]),
      );
      expect(result.metadata.diagnostics?.failedRequests?.[0]?.url).toContain(
        '/failed',
      );
      expect(result.metadata.diagnostics?.redirects).toEqual([
        expect.objectContaining({
          from: `${origin}/redirect`,
          status: 302,
          to: `${origin}/final`,
        }),
      ]);
      expect(result.artifacts?.html).toContain('<main>diagnostics</main>');
      expect(result.artifacts?.mhtml).toContain('MIME-Version: 1.0');
      expect(result.artifacts?.har?.log.entries.length).toBeGreaterThanOrEqual(
        3,
      );

      await expect(
        renderer.evaluate({
          diagnostics: { failureScreenshot: { path: failurePath } },
          source: { html: '<main>failed render</main>' },
          evaluate: async () => {
            throw new Error('capture failure');
          },
        }),
      ).rejects.toThrow('capture failure');
      expect((await readFile(failurePath)).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
    } finally {
      await renderer.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      await rm(directory, { force: true, recursive: true });
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
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/stream') {
        response.write('<main>streaming</main>');
        const interval = setInterval(() => response.write('x'.repeat(1024)), 5);
        response.once('close', () => clearInterval(interval));
        return;
      }
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
      await expect(
        byteLimitedRenderer.evaluate({
          source: { url: `http://127.0.0.1:${address.port}/stream` },
          timeout: 2_000,
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

  test('deduplicates concurrent results and serves TTL cache hits', async () => {
    const renderer = createRenderer({
      ...rendererOptions,
      scheduler: { cacheMaxEntries: 2 },
    });
    let evaluations = 0;
    const options = {
      evaluate: async () => {
        evaluations += 1;
        await new Promise(resolve => setTimeout(resolve, 30));
        return { value: 'cached' };
      },
      resultCache: { key: 'shared-result', ttl: 1_000 },
      source: { html: '<main>cached</main>' } as const,
    };

    try {
      const [first, shared] = await Promise.all([
        renderer.evaluateResult(options),
        renderer.evaluateResult({
          ...options,
          tags: { request: 'shared' },
          tenantId: 'tenant-b',
        }),
      ]);
      const cached = await renderer.evaluateResult(options);

      expect(evaluations).toBe(1);
      expect(first.metadata.cacheHit).toBeUndefined();
      expect(shared.metadata).toMatchObject({
        cacheHit: true,
        tags: { request: 'shared' },
        tenantId: 'tenant-b',
      });
      expect(cached.metadata.cacheHit).toBe(true);
      expect(renderer.stats.succeeded).toBe(1);
    } finally {
      await renderer.close();
    }

    await expect(renderer.evaluateResult(options)).rejects.toBeInstanceOf(
      RendererClosedError,
    );
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

  test('distributes work across a browser pool and recycles instances', async () => {
    const events: RendererEventType[] = [];
    const pool = createRendererPool({
      maxTasksPerBrowser: 1,
      renderer: {
        ...rendererOptions,
        maxConcurrency: 1,
        onEvent: event => {
          events.push(event.type);
        },
      },
      size: 2,
    });

    try {
      const first = await Promise.all([
        pool.evaluate({
          source: { html: '<main>one</main>' },
          evaluate: page => page.$eval('main', element => element.textContent),
        }),
        pool.evaluate({
          source: { html: '<main>two</main>' },
          evaluate: page => page.$eval('main', element => element.textContent),
        }),
      ]);
      expect(first).toEqual(['one', 'two']);
      expect(events.filter(type => type === 'browser.launched')).toHaveLength(
        2,
      );

      await expect(
        pool.evaluate({
          source: { html: '<main>three</main>' },
          evaluate: page => page.$eval('main', element => element.textContent),
        }),
      ).resolves.toBe('three');
      expect(events.filter(type => type === 'browser.launched').length).toBe(3);
      expect(pool.stats).toMatchObject({ size: 2, succeeded: 3 });
    } finally {
      await pool.close();
    }
  }, 30_000);

  test('drains a pool task submitted immediately before close', async () => {
    const pool = createRendererPool({
      renderer: { ...rendererOptions, maxConcurrency: 1 },
      size: 1,
    });
    const accepted = pool.evaluate({
      source: { html: '<main>accepted</main>' },
      evaluate: page => page.$eval('main', element => element.textContent),
    });
    const closing = pool.close();

    await expect(accepted).resolves.toBe('accepted');
    await closing;
  }, 30_000);
});
