# Migration

## Global API to Renderer

The global browser API remains available in the current release, but it is deprecated and will be removed in the next major version.

```ts
// Deprecated
configureBrowserConfig({ executablePath });
await exportToImage({ url, savePath: 'page.png' });
await closeBrowser();

// Current API
const renderer = createRenderer({ executablePath });
try {
  await renderer.image({
    source: { url },
    output: { path: 'page.png' },
  });
} finally {
  await renderer.close();
}
```

Equivalent replacements:

| Deprecated                 | Replacement               |
| -------------------------- | ------------------------- |
| `configureBrowserConfig()` | `createRenderer(options)` |
| `exportToImage()`          | `renderer.image()`        |
| `exportToPdf()`            | `renderer.pdf()`          |
| `getEvalResult()`          | `renderer.evaluate()`     |
| `closeBrowser()`           | `renderer.close()`        |

The renderer API uses isolated BrowserContexts and does not share cookies or local storage between tasks. Pass cookies explicitly or use page hooks when state is required.
