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

`imageResult()`, `pdfResult()`, `compareResult()`, and `evaluateResult()` return task IDs, attempts, queue/render timing, final URLs, HTTP status, page errors, and network counts alongside the data. Pass `selector` to capture one element.

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
- storage-state import for cookies and Web Storage, plus final-state capture
- `desktop`, `mobile`, `tablet`, any Puppeteer `KnownDevices` name, or a custom device
- navigation options for URLs and content options for HTML
- before-navigation and after-navigation hooks
- selector, network-idle, font, delay, text, function, and recursive `all`/`any` waits
- native Puppeteer screenshot and PDF options

Image presets are `open-graph`, `social-square`, and `social-story`; PDF presets are `invoice` and `report`. Explicit viewport, user-agent, and output values override presets. Mobile documents should include a standard `<meta name="viewport">` to lay out at the emulated device width. Captured state contains BrowserContext cookies and Web Storage for the current origin.

## Visual comparison and diagnostics

`compare()` renders a PNG against baseline bytes or a file. It reports pixel and ratio differences, dimension changes, and pass status. It can ignore dynamic elements and write actual and diff images.

```ts
const comparison = await renderer.compare({
  source: { url: 'https://example.com' },
  baseline: 'baselines/home.png',
  ignoreSelectors: ['[data-live-clock]'],
  maxDiffRatio: 0.001,
  actualPath: 'artifacts/home.png',
  diffPath: 'artifacts/home.diff.png',
});
```

Task-level `diagnostics` can capture console messages, failed requests, redirects, HTML, MHTML, a lightweight HAR, and a failure screenshot at an explicit path. The HAR is intended for fast troubleshooting; it does not contain response bodies or full network timing.

## Concurrency, timeouts, and cancellation

The total timeout starts when a task enters the queue. Configure `maxConcurrency`, `maxQueueSize`, and `taskTimeout` on the renderer, or pass a task-level `timeout` and `AbortSignal`. Queue overflow and timeout failures use `RendererQueueFullError` and `RendererTimeoutError`.

`renderer.close()` stops accepting work and drains accepted tasks. `renderer.close({ force: true })` aborts queued and active tasks.

## Scheduling, caching, and browser pools

Pending work runs by descending `priority`, with FIFO ordering for ties. `scheduler` limits concurrency per hostname or tenant and can enforce a minimum interval between starts for one hostname. Set `tenantId` for tenant admission; `tags` are copied into result metadata.

```ts
const renderer = createRenderer({
  scheduler: {
    maxConcurrencyPerHost: 2,
    minHostInterval: 100,
    maxConcurrencyPerTenant: 4,
    cacheMaxEntries: 200,
  },
});

const result = await renderer.imageResult({
  source: { url: 'https://example.com' },
  priority: 10,
  tenantId: 'customer-42',
  resultCache: { key: 'home:desktop:v3', ttl: 60_000 },
});
```

Concurrent tasks with the same `resultCache.key` share one execution. `ttl: 0` only deduplicates in-flight work. Cache keys are an explicit caller contract and must encode the URL, output type, viewport, and every other input that affects a result.

Use `createRendererPool({ size, maxTasksPerBrowser, renderer })` for cross-browser isolation or greater throughput. The pool selects the least-loaded renderer and can recycle an idle browser after a configured task count.

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

`createStructuredLoggerEventSink()`, `createRendererMetricsCollector()`, and `createOpenTelemetryEventSink()` adapt lifecycle events to structured logs, Prometheus, and OpenTelemetry. `composeRendererEventSinks()` attaches all of them while isolating adapter failures from each other and from rendering.

```ts
const metrics = createRendererMetricsCollector();
const renderer = createRenderer({
  onEvent: composeRendererEventSinks(
    createStructuredLoggerEventSink(logger),
    metrics.onEvent,
    createOpenTelemetryEventSink(tracer),
  ),
});

console.log(metrics.toPrometheus());
```

## Network controls and security

`network` supports blocked resource types and URL globs, offline mode, HTTP or proxy credentials, and request rewriting. Configure proxies with renderer-level or task-level `contextOptions.proxyServer`.

For untrusted URLs, explicitly configure `security` with an `allowlist` or `blocklist` plus per-task request and response-byte budgets. The lists are mutually exclusive, and private networks are denied by default once `security` is enabled. Omitting `security` applies no URL or private-network policy.

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

The npm package provides a JSON CLI with `image`, `pdf`, structured `extract`, PNG `compare`, `batch`, and `install-browser` actions. Every request is validated against a JSON Schema before browser launch. Print it with `pptr-helper schema` or `--schema`.

```bash
pnpm exec pptr-helper --input request.json
pnpm exec pptr-helper --ndjson --input requests.ndjson
```

`--ndjson` reads and writes one record per line and continues after line-level failures; the process exits nonzero if any record failed. Both regular and NDJSON modes accept stdin.

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
