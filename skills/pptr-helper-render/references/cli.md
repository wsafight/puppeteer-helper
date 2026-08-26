# JSON CLI

The CLI reads one JSON object from `--input <path>` or stdin and writes one JSON value to stdout. Errors are written to stderr as `{"error":{"name","message","code"}}` and set a non-zero exit code. Every request is validated before browser launch; validation errors use code `CLI_VALIDATION` and include JSON Pointer issues.

Print the JSON Schema 2020-12 contract with either command:

```bash
pptr-helper schema
pptr-helper --schema
```

For streams, pass `--ndjson` with a file or stdin. Blank lines are ignored, output records contain `line` and `status`, and processing continues after invalid JSON or failed renders. The final process exit code is nonzero when any record failed.

```bash
pptr-helper --ndjson --input requests.ndjson
pptr-helper --ndjson < requests.ndjson
```

## Image

```json
{
  "action": "image",
  "renderer": {
    "deterministic": true,
    "retry": { "maxAttempts": 2 },
    "security": {
      "allowlist": ["*://example.com/*"],
      "maxRequests": 100,
      "maxTotalResponseBytes": 20000000
    }
  },
  "task": {
    "source": { "url": "https://example.com" },
    "selector": "main",
    "device": "desktop",
    "preset": "open-graph",
    "wait": {
      "all": [{ "text": "Ready" }, { "selector": "main" }],
      "networkIdle": true,
      "fonts": true
    },
    "output": { "path": "artifacts/example.png", "type": "png" }
  }
}
```

Remove `selector` for a page screenshot. If `output.path` is absent, the response contains `base64` instead of `outputPath`.

Device aliases are `desktop`, `mobile`, and `tablet`; Puppeteer `KnownDevices` names are also accepted. Image presets are `open-graph`, `social-square`, and `social-story`. PDF presets are `invoice` and `report`. Explicit task fields override preset values.

## PDF

```json
{
  "action": "pdf",
  "renderer": { "deterministic": true },
  "task": {
    "source": { "html": "<main><h1>Invoice</h1></main>" },
    "output": {
      "path": "artifacts/invoice.pdf",
      "format": "A4",
      "printBackground": true
    }
  }
}
```

## Extract

Extraction fields support page values or DOM selectors:

```json
{
  "action": "extract",
  "renderer": { "deterministic": true },
  "task": { "source": { "url": "https://example.com" } },
  "fields": {
    "title": { "page": "title" },
    "url": { "page": "url" },
    "heading": { "selector": "h1", "property": "text" },
    "bodyHtml": { "selector": "main", "property": "html" },
    "links": { "selector": "a", "all": true, "attribute": "href" }
  }
}
```

Supported element properties are `text`, `html`, and `value`. Use `attribute` for attributes such as `href`, `src`, or `aria-label`. A missing single element returns `null`; `all: true` returns an array.

## Compare

```json
{
  "action": "compare",
  "renderer": { "deterministic": true },
  "task": {
    "source": { "url": "https://example.com" },
    "baseline": "baselines/home.png",
    "ignoreSelectors": ["[data-live-clock]"],
    "maxDiffRatio": 0.001,
    "actualPath": "artifacts/home.actual.png",
    "diffPath": "artifacts/home.diff.png"
  }
}
```

The response includes pass/fail, differing pixels and ratio, dimension mismatch, and normalized dimensions. Without output paths, actual and diff PNGs are returned as base64. `compare` is also accepted in batch requests.

## Batch

```json
{
  "action": "batch",
  "renderer": { "maxConcurrency": 4 },
  "concurrency": 2,
  "tasks": [
    {
      "id": "home",
      "action": "image",
      "task": {
        "source": { "url": "https://example.com" },
        "output": { "path": "artifacts/home.png" }
      }
    },
    {
      "id": "title",
      "action": "extract",
      "task": { "source": { "url": "https://example.com" } },
      "fields": { "title": { "page": "title" } }
    }
  ]
}
```

Batch output preserves input order. Each item is `fulfilled` or `rejected`; one failure does not discard successful results.

## Browser And Diagnostics

Provision the Puppeteer-compatible Chrome build:

```json
{
  "action": "install-browser",
  "browser": { "cacheDir": "/var/cache/pptr-helper" }
}
```

Set `includeEvents: true` on non-install requests to return renderer lifecycle events alongside the result. Connect to remote Chrome with `renderer.connectOptions.browserWSEndpoint` or `browserURL`. Configure a per-render proxy with `renderer.contextOptions.proxyServer` and credentials with `task.network.credentials`.

Storage state and diagnostics are JSON-native:

```json
{
  "action": "extract",
  "task": {
    "source": { "url": "https://example.com/app" },
    "storageState": {
      "cookies": [],
      "origins": [
        {
          "origin": "https://example.com",
          "localStorage": [{ "name": "theme", "value": "dark" }]
        }
      ]
    },
    "captureStorageState": true,
    "diagnostics": {
      "console": true,
      "failedRequests": true,
      "redirects": true,
      "har": true,
      "html": true,
      "mhtml": true,
      "failureScreenshot": { "path": "artifacts/failure.png" }
    }
  },
  "fields": { "title": { "page": "title" } }
}
```

Metadata carries captured state and diagnostic events; HTML, MHTML, and lightweight HAR data are returned under `artifacts`. The HAR does not include response bodies or complete timing details.

Serializable task controls include `source`, `contextOptions`, `viewport`, `device`, `headers`, `cookies`, `storageState`, `captureStorageState`, `diagnostics`, `navigation`, `content`, composed `wait`, `deterministic`, `network`, `retry`, `taskId`, `priority`, `tenantId`, `tags`, `resultCache`, `timeout`, `selector`, `preset`, visual comparison fields, and native screenshot/PDF `output` options. Renderer-level `scheduler` is also accepted. Function-valued callbacks and OpenTelemetry/logger integrations require the TypeScript API.
