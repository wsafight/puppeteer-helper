# pptr-helper 开发说明

公开用法与 API 示例以 [README.md](./README.md) 为准。

## 架构

- `src/renderer.ts`：实例化渲染 API、浏览器生命周期和独立任务上下文
- `src/browser/managed-browser.ts`：匹配 Puppeteer revision 的 Chrome for Testing 管理
- `src/internal/task-queue.ts`：并发限制、队列背压和 drain
- `src/internal/task-signal.ts`：任务超时、调用方取消和强制关闭信号
- `src/scheduler.ts`：主机/租户准入、启动间隔与调度配置校验
- `src/pool.ts`：多 renderer 负载分配和空闲浏览器回收
- `src/deterministic.ts`：稳定渲染环境、懒加载、图片和字体等待
- `src/network.ts`：请求控制、Chrome URL guard、安全预算与网络统计
- `src/diagnostics.ts`：页面事件诊断、轻量 HAR、HTML/MHTML 和失败截图
- `src/visual.ts`：PNG 解码、尺寸归一、像素比较和差异图
- `src/presets.ts`：设备、社交图片和 PDF 输出预设
- `src/observability.ts`：日志、Prometheus 和 OpenTelemetry 事件适配
- `src/cli-schema.ts`：CLI JSON Schema 2020-12
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

`compareResult` 同样使用元数据管线。页面诊断监听器、CDP session 和 BrowserContext 必须在每次尝试后释放；失败截图是 best-effort，不能覆盖原始任务错误。组合等待的子分支使用独立 AbortController，`any` 胜出或 `all` 失败后必须取消其余分支。

## 调度、缓存与池约定

队列只对 pending 项按 priority 排序，同优先级保持提交顺序；正在运行的任务不会被抢占。hostname/tenant 准入等待计入任务总 timeout。HTML source 没有 hostname，因此只参与全局和 tenant 限制。

结果缓存必须由任务显式提供 key。相同 key 始终做 in-flight dedupe，只有正 TTL 才保存成功结果；失败不缓存，过期项惰性删除，容量按最近访问顺序淘汰。共享结果的等待方有独立取消与 timeout，但取消等待不会中止所有者任务。

浏览器池在调用 renderer 前先登记 reservation，避免同时提交时都选择同一 slot。只有 renderer 完全空闲并达到 `maxTasksPerBrowser` 后才能回收；pool close 必须等待已启动的回收完成。

## 可观测性约定

Renderer 事件接收器始终是非阻塞、错误隔离的。结构化日志器序列化 Error；指标采集器只维护进程内 counter/gauge 并生成 Prometheus text format；OpenTelemetry 适配器用 taskId 管理 task span，库本身不依赖 OTel 包。多个接收器通过 `composeRendererEventSinks` 组合。

## 网络与安全约定

请求监听器直接返回异步拦截逻辑；Puppeteer 25 的 `Page.on('request')` 已负责加入 cooperative interception 队列，不能在监听器内部再次调用 `enqueueInterceptAction()`。

`security` 是显式启用的；省略时不应用 URL 或私网访问策略。启用后，`security.allowlist`/`blocklist` 映射到 Puppeteer 的 Chrome URLPattern guard，私网默认禁止。请求数、CDP 实时响应字节预算和响应 remote address 检查属于任务级防御；仍需容器或 OS egress policy 提供完整网络隔离。

## 兼容层

旧版全局 API 暂时保留，但不再扩展能力。新功能应添加到 `Renderer` 实例 API，并通过测试覆盖资源关闭、并发和实际渲染结果。
