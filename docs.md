# pptr-helper 开发说明

公开用法与 API 示例以 [README.md](./README.md) 为准。

## 架构

- `src/renderer.ts`：实例化渲染 API、浏览器生命周期和独立任务上下文
- `src/browser/managed-browser.ts`：匹配 Puppeteer revision 的 Chrome for Testing 管理
- `src/internal/task-queue.ts`：并发限制、队列背压和 drain
- `src/internal/task-signal.ts`：任务超时、调用方取消和强制关闭信号
- `src/deterministic.ts`：稳定渲染环境、懒加载、图片和字体等待
- `src/network.ts`：请求控制、Chrome URL guard、安全预算与网络统计
- `bin/pptr-helper.mjs`：面向自动化和 AI agent 的 JSON CLI
- `skills/pptr-helper-render/`：CLI 优先、API 按需加载的 Codex skill
- `src/browser/`：旧版全局浏览器配置和兼容层
- `src/export/`：旧版截图、PDF API
- `src/helper/`：旧版页面回调 API
- `rslib.config.ts`：ESM、CommonJS 和声明文件构建
- `vitest.config.ts`：单元测试与真实 Chrome 集成测试

## 生命周期约定

`createRenderer()` 延迟启动浏览器，并合并并发的首次启动请求。每个渲染任务创建独立 BrowserContext，并在成功或失败后关闭。普通 `renderer.close()` drain 已接收任务，force close 通过共享 shutdown signal 中止任务；关闭后的实例不能再次执行任务。

传入 `connectOptions` 时 renderer 不拥有远程 Browser：关闭只调用 `disconnect()`。本地 launch 或托管 Chrome 由 renderer 拥有，关闭调用 `close()`。断连事件会清除缓存引用，后续可重试任务重新连接或启动。

## 执行与重试约定

一次逻辑任务只占用一个队列槽，重试在该槽内依次执行，每次创建新的 BrowserContext。`RendererError` 不重试；其他错误仅在显式配置 `maxAttempts > 1` 时重试。任务总 timeout 覆盖排队、所有尝试和退避等待。

`imageResult`、`pdfResult` 和 `evaluateResult` 共享同一元数据管线。旧数据方法委托给 result 方法，因此不能维护两套行为。批量 API 只负责有界提交与结果聚合，最终背压仍由 renderer 队列控制。

## 网络与安全约定

请求监听器直接返回异步拦截逻辑；Puppeteer 25 的 `Page.on('request')` 已负责加入 cooperative interception 队列，不能在监听器内部再次调用 `enqueueInterceptAction()`。

`security.allowlist`/`blocklist` 映射到 Puppeteer 的 Chrome URLPattern guard。请求数、CDP encoded byte 预算和响应 remote address 检查属于任务级防御；仍需容器或 OS egress policy 提供完整网络隔离。

## 兼容层

旧版全局 API 暂时保留，但不再扩展能力。新功能应添加到 `Renderer` 实例 API，并通过测试覆盖资源关闭、并发和实际渲染结果。
