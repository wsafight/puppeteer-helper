# pptr-helper

[简体中文](./README.md)

Deterministic webpage rendering built on Puppeteer. It manages the browser lifecycle, isolates rendering jobs, and provides screenshot, PDF, and page extraction APIs.

## Requirements

- Node.js >= 24
- Chrome or Chromium

The current release uses `puppeteer-core@25.9.0`. When no browser path is provided, the first task installs the matching Chrome for Testing build and reuses the local cache.

## Install

```bash
pnpm add pptr-helper
```

## Quick start

```ts
import { createRenderer } from 'pptr-helper';

const renderer = createRenderer({
  deterministic: true,
  maxConcurrency: 4,
  maxQueueSize: 100,
  taskTimeout: 30_000,
});

try {
  await renderer.image({
    source: { url: 'https://example.com' },
    viewport: { width: 1440, height: 900 },
    wait: {
      selector: 'main',
      fonts: true,
      networkIdle: { idleTime: 500 },
    },
    output: {
      path: 'example.png',
      fullPage: true,
    },
  });
} finally {
  await renderer.close();
}
```

## Browser management

The default cache is `~/.cache/pptr-helper`. Override it with `PPTR_CACHE_DIR` or `browser.cacheDir`.

You may use an existing browser through `executablePath`, `PPTR_EXECUTABLE_PATH`, or `launchOptions.channel`. Set `browser.autoInstall: false` for strict offline operation. Use `installCompatibleChrome()` to provision the browser during deployment; `COMPATIBLE_CHROME_REVISION` exposes the pinned build.

For Browserless or container Chrome, pass `connectOptions.browserWSEndpoint` or `browserURL`. Remote connection options cannot be mixed with local launch options. `renderer.close()` disconnects only this client and does not shut down the shared browser.

## Render HTML

Screenshots and PDFs return a `Uint8Array` when no output path is provided.

```ts
const pdf = await renderer.pdf({
  source: { html: '<main><h1>Invoice</h1></main>' },
  wait: { fonts: true },
  output: {
    format: 'A4',
    printBackground: true,
  },
});
```

## Extract page data

```ts
const links = await renderer.evaluate({
  source: { url: 'https://example.com' },
  evaluate: page =>
    page.$$eval('a', elements =>
      elements.map(element => ({
        href: element.href,
        text: element.textContent?.trim() ?? '',
      })),
    ),
});
```

Each job runs in an isolated BrowserContext. Contexts are closed after failures, and one renderer can safely run concurrent jobs.

## Element screenshots and result metadata

`imageResult()`, `pdfResult()`, and `evaluateResult()` return task IDs, attempts, queue/render timing, final URLs, HTTP status, page errors, and network counts alongside the data. Pass `selector` to capture one element.

```ts
const result = await renderer.imageResult({
  taskId: 'invoice-header',
  source: { url: 'https://example.com/invoice/42' },
  selector: 'header.invoice',
  output: { path: 'invoice-header.png' },
});
```

## Page preparation

`RenderPageOptions` supports:

- viewport, user agent, headers, and cookies
- navigation options for URLs and content options for HTML
- before-navigation and after-navigation hooks
- selector, network-idle, and font readiness conditions
- native Puppeteer screenshot and PDF options

## Concurrency, timeouts, and cancellation

The total timeout starts when a task enters the queue. Configure `maxConcurrency`, `maxQueueSize`, and `taskTimeout` on the renderer, or pass a task-level `timeout` and `AbortSignal`. Queue overflow and timeout failures use `RendererQueueFullError` and `RendererTimeoutError`.

`renderer.close()` stops accepting work and drains accepted tasks. `renderer.close({ force: true })` aborts queued and active tasks.

## Retries, batches, and events

Retries are disabled by default to avoid repeating page operations with side effects. Configure attempts, backoff, and an optional predicate at renderer or task level. Timeout, cancellation, closed, queue, and security errors are never retried.

```ts
const renderer = createRenderer({
  retry: { maxAttempts: 3, delay: 100, backoff: 2, maxDelay: 2_000 },
  onEvent: event => logger.info(event),
});

const results = await renderer.batch(tasks, {
  concurrency: 2,
  signal: controller.signal,
  onProgress: (completed, total) => report(completed / total),
});
```

Batch results preserve input order and mark each item as `fulfilled` or `rejected`. Renderer stats include successful and failed task counts.

## Network controls and security

`network` supports blocked resource types and URL globs, offline mode, HTTP or proxy credentials, and request rewriting. Configure proxies with renderer-level or task-level `contextOptions.proxyServer`.

For untrusted URLs, use `security.allowlist` or `blocklist` plus per-task request and response-byte budgets. The lists are mutually exclusive and private networks are denied by default.

```ts
const renderer = createRenderer({
  security: {
    allowlist: ['*://example.com/*', '*://*.example.com/*'],
    maxRequests: 100,
    maxTotalResponseBytes: 20_000_000,
  },
  network: {
    blockedResourceTypes: ['media', 'font'],
    blockedUrls: ['*://*/analytics/*'],
  },
});
```

These settings are browser guardrails, not a replacement for container or operating-system network isolation.

## Deterministic preset

`deterministic: true` disables cache and animations, fixes UTC, `en-US`, light color scheme, and reduced motion, scrolls lazy content into view, and waits for images and fonts. Pass options such as `now`, `scroll`, `timezone`, or `locale` to customize the preset. A task-level value overrides the renderer default.

## JSON CLI and AI skill

The npm package provides a JSON CLI with `image`, `pdf`, structured `extract`, `batch`, and `install-browser` actions. It accepts a file or stdin and returns JSON results and structured errors.

```bash
pnpm exec pptr-helper --input request.json
```

The repository and npm package also include the [`pptr-helper-render` skill](./skills/pptr-helper-render/SKILL.md). Agents that support `SKILL.md` can register this directory and use the CLI for deterministic rendering; detailed CLI and TypeScript guidance is loaded from the skill references only when needed.

## Legacy API

`configureBrowserConfig`, `exportToImage`, `exportToPdf`, and `getEvalResult` remain available with deprecation markers. New projects should use `createRenderer`; see [MIGRATION.md](./MIGRATION.md) for direct replacements.

## Development

Rslib builds ESM, CommonJS, and TypeScript declarations.

```bash
fnm use
pnpm install
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:browser
pnpm test
pnpm build
```

Browser integration tests use `PPTR_EXECUTABLE_PATH` and detect common Chrome locations on macOS and Linux. Set `PPTR_AUTO_INSTALL=true` and `PPTR_FORCE_MANAGED=true` to test the managed-browser path.

## License

MIT
