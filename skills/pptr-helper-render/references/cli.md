# JSON CLI

The CLI reads one JSON object from `--input <path>` or stdin and writes one JSON value to stdout. Errors are written to stderr as `{"error":{"name","message","code"}}` and set a non-zero exit code.

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
    "viewport": { "width": 1440, "height": 900 },
    "wait": { "networkIdle": true, "fonts": true },
    "output": { "path": "artifacts/example.png", "type": "png" }
  }
}
```

Remove `selector` for a page screenshot. If `output.path` is absent, the response contains `base64` instead of `outputPath`.

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

Serializable task controls include `source`, `contextOptions`, `viewport`, `headers`, `cookies`, `navigation`, `content`, `wait`, `deterministic`, `network`, `retry`, `taskId`, `timeout`, `selector`, and native screenshot/PDF `output` options. Function-valued callbacks require the TypeScript API.
