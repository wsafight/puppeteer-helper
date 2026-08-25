# pptr-helper

[English](./README.EN.md)

基于 Puppeteer 的确定性网页渲染工具。它提供浏览器生命周期管理、隔离的渲染任务，以及截图、PDF 和页面数据提取能力。

## 环境要求

- Node.js >= 24
- Chrome 或 Chromium

当前版本使用 `puppeteer-core@25.9.0`。未提供浏览器路径时，会在首次任务中自动安装与 Puppeteer 匹配的 Chrome for Testing，并复用本地缓存。

## 安装

```bash
pnpm add pptr-helper
```

## 快速开始

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

## 浏览器管理

默认缓存目录是 `~/.cache/pptr-helper`，可以通过 `PPTR_CACHE_DIR` 或 `browser.cacheDir` 修改。

```ts
const renderer = createRenderer({
  browser: {
    autoInstall: true,
    cacheDir: '/var/cache/pptr-helper',
  },
});
```

也可以通过 `executablePath`、`PPTR_EXECUTABLE_PATH` 或 `launchOptions.channel` 使用已有浏览器。离线环境可以设置 `browser.autoInstall: false`，缺少浏览器时会立即报错。`installCompatibleChrome()` 可用于部署阶段预装浏览器，`COMPATIBLE_CHROME_REVISION` 则公开当前锁定版本。

使用 Browserless 或容器 Chrome 时传入 `connectOptions.browserWSEndpoint` 或 `browserURL`。远程连接不能与本地启动选项混用；`renderer.close()` 只断开当前客户端，不会关闭共享浏览器。

```ts
const renderer = createRenderer({
  connectOptions: {
    browserWSEndpoint: process.env.CHROME_WS_ENDPOINT,
  },
});
```

## 渲染 HTML

截图和 PDF 在未提供输出路径时会直接返回 `Uint8Array`。

```ts
const pdf = await renderer.pdf({
  source: {
    html: '<main><h1>Invoice</h1></main>',
  },
  wait: { fonts: true },
  output: {
    format: 'A4',
    printBackground: true,
  },
});
```

## 提取页面数据

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

每个任务运行在独立的 BrowserContext 中。即使任务失败，上下文也会被关闭；同一个 renderer 可以安全地执行并发任务。

## 元素截图与结果元数据

`imageResult()`、`pdfResult()` 和 `evaluateResult()` 在数据之外返回任务 ID、尝试次数、排队/渲染耗时、最终 URL、HTTP 状态、页面错误和网络统计。截图可以通过 `selector` 限定到单个元素。

```ts
const result = await renderer.imageResult({
  taskId: 'invoice-header',
  source: { url: 'https://example.com/invoice/42' },
  selector: 'header.invoice',
  output: { path: 'invoice-header.png' },
});

console.log(result.metadata);
```

## 页面准备

`RenderPageOptions` 支持以下常见场景：

- `viewport`、`userAgent`、`headers` 和 `cookies`
- URL 的 `navigation` 和 HTML 的 `content` 等待选项
- `beforeNavigate`、`afterNavigate` 页面钩子
- selector、network idle 和字体等待条件
- Puppeteer 原生截图及 PDF 输出选项

## 并发、超时与取消

任务从进入队列时开始计算总超时。队列达到 `maxQueueSize` 时会抛出 `RendererQueueFullError`，任务超时会抛出 `RendererTimeoutError`。

```ts
const controller = new AbortController();

const task = renderer.image({
  source: { url: 'https://example.com' },
  signal: controller.signal,
  timeout: 10_000,
});

console.log(renderer.stats); // active、pending 和并发限制
controller.abort();
await task;
```

`renderer.close()` 停止接收新任务并等待已经接收的任务完成。需要立即中止时使用 `renderer.close({ force: true })`。

## 重试、批量与事件

重试默认关闭，避免重复执行有副作用的页面操作。可以在 renderer 或单个任务上配置最大尝试次数、退避和错误判断；超时、取消、关闭、队列满和安全错误不会重试。

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

批量结果保持输入顺序，并分别标记 `fulfilled` 或 `rejected`，单个失败不会丢失其他结果。`renderer.stats` 还提供任务成功与失败计数。

## 网络控制与安全

`network` 支持资源类型和 URL glob 阻断、离线模式、HTTP/代理认证以及自定义请求改写。代理服务器通过 renderer 或任务级 `contextOptions.proxyServer` 配置。

面向不可信 URL 时，使用 `security.allowlist` 或 `blocklist` 限制 Chrome 可访问的地址，并设置每个任务的请求数和总响应字节预算。两种列表不能同时使用；私网默认禁止。

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

这些配置是浏览器层护栏，不能替代容器或操作系统级网络隔离。

## 确定性预设

`deterministic: true` 会关闭缓存和动画，固定 UTC、`en-US`、light color scheme 和 reduced motion，自动滚动触发懒加载，并等待图片及字体。

```ts
await renderer.image({
  source: { url: 'https://example.com' },
  deterministic: {
    now: '2024-01-02T03:04:05.000Z',
    scroll: { distance: 600, delay: 50, maxSteps: 200 },
  },
});
```

任务级 `deterministic` 会覆盖 renderer 的默认预设；传入 `false` 可以为单个任务关闭。

## JSON CLI 与 AI Skill

npm 包提供 `pptr-helper` JSON CLI，支持 `image`、`pdf`、结构化 `extract`、`batch` 和 `install-browser`。输入可来自文件或 stdin，结果和结构化错误均为 JSON。

```bash
pnpm exec pptr-helper --input request.json
```

仓库和发布包同时包含 [`pptr-helper-render` skill](./skills/pptr-helper-render/SKILL.md)。支持 `SKILL.md` 的 AI agent 注册该目录后，可优先通过 CLI 完成确定性渲染；JSON schema 与高级 TypeScript API 分别位于 skill 的按需 reference 中。

## 旧版 API

`configureBrowserConfig`、`exportToImage`、`exportToPdf` 和 `getEvalResult` 仍然保留以兼容旧代码，并已标记为 deprecated。新项目应使用 `createRenderer`，迁移映射见 [MIGRATION.md](./MIGRATION.md)。

## 开发

项目使用 Rslib 构建 ESM、CommonJS 和 TypeScript 声明文件。

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

真实浏览器测试会使用 `PPTR_EXECUTABLE_PATH`，并在 macOS、常见 Linux Chrome 路径中自动探测可执行文件。设置 `PPTR_AUTO_INSTALL=true` 和 `PPTR_FORCE_MANAGED=true` 可以验证托管 Chrome 下载路径。

## License

MIT
