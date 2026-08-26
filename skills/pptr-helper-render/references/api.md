# TypeScript API

Use this API when a render requires Puppeteer callbacks or application integration that the JSON CLI cannot express.

## Devices, State, And Waits

```ts
const result = await renderer.imageResult({
  source: { url: 'https://example.com/app' },
  device: 'mobile', // aliases, KnownDevices names, and custom Device objects
  storageState: savedState,
  captureStorageState: true,
  preset: 'social-story',
  wait: {
    all: [{ text: 'Ready' }, { function: 'globalThis.appReady === true' }],
    any: [{ selector: '[data-result]' }, { delay: 2_000 }],
    fonts: true,
  },
});

const nextState = result.metadata.storageState;
```

Device aliases are `desktop`, `mobile`, and `tablet`. Image output presets are `open-graph`, `social-square`, and `social-story`; PDF presets are `invoice` and `report`. Explicit viewport, user-agent, and output fields win over presets. Mobile HTML needs a viewport meta tag to use the emulated layout width.

Storage-state import restores cookies plus local/session storage before navigation. Capture returns BrowserContext cookies and Web Storage for the final page origin.

## Visual Regression And Diagnostics

```ts
const comparison = await renderer.compareResult({
  source: { url: 'https://example.com' },
  baseline: 'baselines/home.png',
  ignoreSelectors: ['[data-live-clock]'],
  maxDiffPixels: 20,
  maxDiffRatio: 0.001,
  actualPath: 'artifacts/home.actual.png',
  diffPath: 'artifacts/home.diff.png',
  diagnostics: {
    console: true,
    failedRequests: true,
    redirects: true,
    har: true,
    html: true,
    mhtml: true,
    failureScreenshot: { path: 'artifacts/home.failure.png' },
  },
});
```

`compare` and `compareResult` report `passed`, `diffPixels`, `diffRatio`, `dimensionMismatch`, and normalized dimensions, plus actual/diff PNG bytes. `threshold` controls per-pixel sensitivity; `maxDiffPixels` and `maxDiffRatio` control pass/fail. Dimension changes always fail. The HAR is intentionally lightweight and omits response bodies and full timing detail.

## Remote Chrome And Recovery

```ts
const renderer = createRenderer({
  connectOptions: {
    browserWSEndpoint: process.env.CHROME_WS_ENDPOINT,
    headers: { authorization: `Bearer ${process.env.CHROME_TOKEN}` },
  },
  retry: {
    maxAttempts: 3,
    delay: 100,
    backoff: 2,
    maxDelay: 2_000,
  },
});
```

Remote `close()` disconnects the Puppeteer client without shutting down the shared browser. Retrying is opt-in; `RendererError` subclasses such as timeout, cancellation, queue, security, and closed errors are never retried.

## Requests And Security

```ts
const renderer = createRenderer({
  security: {
    allowlist: ['*://example.com/*', '*://*.example.com/*'],
    allowPrivateNetwork: false,
    maxRequests: 100,
    maxTotalResponseBytes: 20_000_000,
  },
  network: {
    blockedResourceTypes: ['media', 'font'],
    blockedUrls: ['*://*/analytics/*'],
    onRequest: request =>
      request.url().includes('tracking') ? 'abort' : 'continue',
  },
  contextOptions: {
    proxyServer: 'http://proxy.internal:8080',
  },
});
```

`security` is opt-in; omitting it applies no URL or private-network policy. Once enabled, private networks are denied by default, and `security.allowlist` and `security.blocklist` are mutually exclusive Chrome URLPattern lists. The private-network checks and browser lists are defense in depth, not a complete network sandbox.

## Metadata, Elements, And Events

```ts
const events: RendererEvent[] = [];
const renderer = createRenderer({
  onEvent: event => {
    events.push(event);
  },
});

const result = await renderer.imageResult({
  taskId: 'invoice-header',
  source: { url: 'https://example.com/invoice/42' },
  selector: 'header.invoice',
  output: { path: 'invoice-header.png' },
});

console.log(result.metadata);
```

Result methods are `imageResult`, `pdfResult`, `compareResult`, and `evaluateResult`. Metadata includes the task ID, attempts, queue/render/total timing, final URL, navigation status, page errors, request counts, optional diagnostics/storage state, cache status, tenant ID, and tags. Existing `image`, `pdf`, `compare`, and `evaluate` methods return only data.

## Scheduling And Result Caching

```ts
const renderer = createRenderer({
  maxConcurrency: 8,
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
  tenantId: 'tenant-a',
  tags: { workflow: 'daily-report' },
  resultCache: { key: 'image:https://example.com:1440x900:v2', ttl: 60_000 },
});
```

Higher-priority pending work runs first and FIFO order is preserved for ties. Running work is never preempted. Host/tenant admission time counts toward the task timeout. Every explicit cache key deduplicates in-flight work; positive TTL values also retain successful results. Failures are not cached. Callers must encode every result-affecting input into the key.

## Batch

```ts
const results = await renderer.batch(
  [
    {
      id: 'title',
      type: 'evaluate',
      options: {
        source: { url: 'https://example.com' },
        evaluate: page => page.title(),
      },
    },
    {
      id: 'page',
      type: 'image',
      options: {
        source: { url: 'https://example.com' },
        output: { path: 'page.png' },
      },
    },
  ],
  { concurrency: 2, signal },
);
```

Batch results preserve input order and report partial failures. The renderer queue remains the final concurrency and backpressure boundary.

## Browser Pool

```ts
const pool = createRendererPool({
  size: 3,
  maxTasksPerBrowser: 500,
  renderer: { maxConcurrency: 4, taskTimeout: 30_000 },
});

try {
  await pool.batch(tasks, { concurrency: 12 });
} finally {
  await pool.close();
}
```

The pool implements the `Renderer` interface, selects the least-loaded slot, aggregates stats, and only recycles browsers after their renderer becomes idle.

## Observability Adapters

```ts
const metrics = createRendererMetricsCollector();
const renderer = createRenderer({
  onEvent: composeRendererEventSinks(
    createStructuredLoggerEventSink(logger),
    metrics.onEvent,
    createOpenTelemetryEventSink(tracer),
  ),
});

const snapshot = metrics.snapshot();
const prometheusText = metrics.toPrometheus();
```

The logger adapter maps retries to warn and failures to error while serializing `Error` values. The metrics collector tracks browser events and task counters plus active/pending gauges. The OpenTelemetry adapter accepts a structural tracer interface, so `pptr-helper` does not require `@opentelemetry/api`. Composed sinks isolate adapter failures.
