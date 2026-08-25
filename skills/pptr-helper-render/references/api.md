# TypeScript API

Use this API when a render requires Puppeteer callbacks or application integration that the JSON CLI cannot express.

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

`security.allowlist` and `security.blocklist` are mutually exclusive Chrome URLPattern lists. The private-network checks and browser lists are defense in depth, not a complete network sandbox.

## Metadata, Elements, And Events

```ts
const events: RendererEvent[] = [];
const renderer = createRenderer({
  onEvent: event => events.push(event),
});

const result = await renderer.imageResult({
  taskId: 'invoice-header',
  source: { url: 'https://example.com/invoice/42' },
  selector: 'header.invoice',
  output: { path: 'invoice-header.png' },
});

console.log(result.metadata);
```

Result methods are `imageResult`, `pdfResult`, and `evaluateResult`. Metadata includes the task ID, attempts, queue/render/total timing, final URL, navigation status, page errors, and request counts. Existing `image`, `pdf`, and `evaluate` methods still return only data.

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
