import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import {
  connect,
  launch,
  type Browser,
  type BrowserContextOptions,
  type ConnectOptions,
  type CookieData,
  type GoToOptions,
  type HTTPResponse,
  type LaunchOptions,
  type Page,
  type PDFOptions,
  type ScreenshotOptions,
  type SetContentWaitForOptions,
  type Viewport,
  type WaitForNetworkIdleOptions,
  type WaitForSelectorOptions,
} from 'puppeteer-core';

import { getDefaultViewport } from './constants';
import {
  getDeterministicHeaders,
  prepareDeterministicPage,
  resolveDeterministicOptions,
  waitForDeterministicPage,
  type DeterministicPreset,
} from './deterministic';
import { RendererClosedError, RendererError } from './errors';
import {
  resolveManagedBrowser,
  type BrowserManagementOptions,
} from './browser/managed-browser';
import { TaskQueue } from './internal/task-queue';
import { createTaskSignal, raceWithSignal } from './internal/task-signal';
import {
  assertNavigationAllowed,
  getBrowserSecurityOptions,
  setupPageNetwork,
  validateSecurityOptions,
  type NetworkOptions,
  type NetworkStats,
  type RendererSecurityOptions,
} from './network';

type Awaitable<T> = T | Promise<T>;

export type RenderSource =
  { url: string; html?: never } | { html: string; url?: never };

export interface RenderWaitOptions {
  /** Wait until this selector exists before producing output. */
  selector?: string;
  selectorOptions?: WaitForSelectorOptions;
  /** Wait for the network to become idle after navigation and hooks run. */
  networkIdle?: boolean | WaitForNetworkIdleOptions;
  /** Wait until all document fonts are ready. */
  fonts?: boolean;
}

export interface RenderPageOptions {
  source: RenderSource;
  /** Override BrowserContext settings such as a per-task proxy. */
  contextOptions?: BrowserContextOptions;
  viewport?: Viewport;
  userAgent?: string;
  headers?: Record<string, string>;
  cookies?: CookieData[];
  navigation?: GoToOptions;
  content?: SetContentWaitForOptions;
  wait?: RenderWaitOptions;
  /** Override the renderer-level deterministic rendering preset. */
  deterministic?: DeterministicPreset;
  /** Override renderer-level request controls for this task. */
  network?: NetworkOptions;
  /** Override renderer-level retry behavior for this task. */
  retry?: false | RendererRetryOptions;
  /** Abort this task while it is queued or running. */
  signal?: AbortSignal;
  /** Correlation identifier used in events and result metadata. */
  taskId?: string;
  /** Total queue and execution timeout. Use 0 to disable. */
  timeout?: number;
  beforeNavigate?: (page: Page) => Awaitable<void>;
  afterNavigate?: (page: Page) => Awaitable<void>;
}

export interface ImageRenderOptions extends RenderPageOptions {
  /** Capture one element instead of the whole page. */
  selector?: string;
  selectorOptions?: WaitForSelectorOptions;
  output?: ScreenshotOptions;
}

export interface PdfRenderOptions extends RenderPageOptions {
  output?: PDFOptions;
}

export interface EvaluateOptions<T> extends RenderPageOptions {
  evaluate: (page: Page) => Awaitable<T>;
}

export interface RendererRetryOptions {
  /** Total attempts, including the first one. @defaultValue 1 */
  maxAttempts?: number;
  /** Delay before the second attempt in milliseconds. @defaultValue 100 */
  delay?: number;
  /** Delay multiplier after each failure. @defaultValue 2 */
  backoff?: number;
  /** Upper delay bound in milliseconds. @defaultValue 2000 */
  maxDelay?: number;
  shouldRetry?: (error: unknown, attempt: number) => Awaitable<boolean>;
}

export type RendererEventType =
  | 'browser.connected'
  | 'browser.disconnected'
  | 'browser.launched'
  | 'task.failed'
  | 'task.queued'
  | 'task.retry'
  | 'task.started'
  | 'task.succeeded';

export interface RendererEvent {
  type: RendererEventType;
  timestamp: number;
  taskId?: string;
  attempt?: number;
  error?: unknown;
}

export interface RenderMetadata {
  taskId: string;
  attempts: number;
  queuedAt: number;
  startedAt: number;
  finishedAt: number;
  queueDuration: number;
  renderDuration: number;
  totalDuration: number;
  finalUrl: string;
  statusCode?: number;
  pageErrors: string[];
  network: NetworkStats;
}

export interface RenderResult<T> {
  data: T;
  metadata: RenderMetadata;
}

export type RendererBatchTask =
  | { id?: string; type: 'image'; options: ImageRenderOptions }
  | { id?: string; type: 'pdf'; options: PdfRenderOptions }
  | { id?: string; type: 'evaluate'; options: EvaluateOptions<unknown> };

export interface RendererBatchOptions {
  /** Number of batch workers submitting tasks. Defaults to renderer concurrency. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => Awaitable<void>;
}

export type RendererBatchResult =
  | {
      id?: string;
      index: number;
      status: 'fulfilled';
      result: RenderResult<unknown>;
    }
  | {
      id?: string;
      index: number;
      status: 'rejected';
      error: unknown;
    };

export interface RendererOptions {
  /** Chrome/Chromium executable. Falls back to PPTR_EXECUTABLE_PATH. */
  executablePath?: string;
  /** Native Puppeteer launch options. executablePath is configured above. */
  launchOptions?: Omit<LaunchOptions, 'executablePath'>;
  /** Connect to an existing remote browser instead of launching one. */
  connectOptions?: ConnectOptions;
  /** BrowserContext defaults merged into every task. */
  contextOptions?: BrowserContextOptions;
  /** Matching Chrome for Testing download and cache settings. */
  browser?: BrowserManagementOptions;
  /** Maximum number of pages that may render at once. @defaultValue 4 */
  maxConcurrency?: number;
  /** Maximum number of accepted tasks waiting to run. @defaultValue 100 */
  maxQueueSize?: number;
  /** Default total queue and execution timeout in milliseconds. @defaultValue 30000 */
  taskTimeout?: number;
  /** Default deterministic rendering preset for every task. */
  deterministic?: DeterministicPreset;
  /** Default request controls for every task. */
  network?: NetworkOptions;
  /** Opt-in retry policy for transient task failures. */
  retry?: RendererRetryOptions;
  /** Browser and per-task network guardrails. */
  security?: RendererSecurityOptions;
  /** Non-blocking lifecycle event sink. */
  onEvent?: (event: RendererEvent) => Awaitable<void>;
}

export interface RendererCloseOptions {
  /** Abort active and queued tasks instead of draining them. */
  force?: boolean;
}

export interface RendererStats {
  active: number;
  pending: number;
  maxConcurrency: number;
  maxQueueSize: number;
  closing: boolean;
  succeeded: number;
  failed: number;
}

export interface Renderer {
  image(
    options: ImageRenderOptions & {
      output: ScreenshotOptions & { encoding: 'base64' };
    },
  ): Promise<string>;
  image(options: ImageRenderOptions): Promise<Uint8Array>;
  imageResult(
    options: ImageRenderOptions & {
      output: ScreenshotOptions & { encoding: 'base64' };
    },
  ): Promise<RenderResult<string>>;
  imageResult(options: ImageRenderOptions): Promise<RenderResult<Uint8Array>>;
  pdf(options: PdfRenderOptions): Promise<Uint8Array>;
  pdfResult(options: PdfRenderOptions): Promise<RenderResult<Uint8Array>>;
  evaluate<T>(options: EvaluateOptions<T>): Promise<T>;
  evaluateResult<T>(options: EvaluateOptions<T>): Promise<RenderResult<T>>;
  batch(
    tasks: readonly RendererBatchTask[],
    options?: RendererBatchOptions,
  ): Promise<RendererBatchResult[]>;
  readonly stats: RendererStats;
  close(options?: RendererCloseOptions): Promise<void>;
}

const validateSource = (source: RenderSource) => {
  const hasUrl = 'url' in source;
  const value = hasUrl ? source.url : source.html;

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${hasUrl ? 'url' : 'html'} cannot be empty`);
  }
};

const isUrlSource = (
  source: RenderSource,
): source is { url: string; html?: never } => typeof source.url === 'string';

interface PageAttemptResult<T> {
  data: T;
  finalUrl: string;
  statusCode?: number;
  pageErrors: string[];
  network: NetworkStats;
}

interface RetriedPageResult<T> extends PageAttemptResult<T> {
  attempts: number;
}

interface ResolvedRetryOptions {
  maxAttempts: number;
  delay: number;
  backoff: number;
  maxDelay: number;
  shouldRetry?: RendererRetryOptions['shouldRetry'];
}

class PuppeteerRenderer implements Renderer {
  readonly #options: RendererOptions;
  readonly #queue: TaskQueue;
  readonly #shutdown = new AbortController();
  readonly #maxConcurrency: number;
  readonly #taskTimeout: number;
  #browser?: Browser;
  #launching?: Promise<Browser>;
  #closing?: Promise<void>;
  #closed = false;
  #ownsBrowser = true;
  #succeeded = 0;
  #failed = 0;

  constructor(options: RendererOptions) {
    const maxConcurrency = options.maxConcurrency ?? 4;
    const maxQueueSize = options.maxQueueSize ?? 100;
    const taskTimeout = options.taskTimeout ?? 30_000;

    this.#validateInteger('maxConcurrency', maxConcurrency, 1);
    this.#validateInteger('maxQueueSize', maxQueueSize, 0);
    this.#validateInteger('taskTimeout', taskTimeout, 0);
    this.#validateRetry(options.retry);
    validateSecurityOptions(options.security);
    if (
      options.connectOptions &&
      (options.executablePath || options.launchOptions || options.browser)
    ) {
      throw new Error(
        'connectOptions cannot be combined with executablePath, launchOptions, or browser',
      );
    }
    const nativeBrowserOptions =
      options.connectOptions ?? options.launchOptions;
    if (
      options.security &&
      (nativeBrowserOptions?.allowlist?.length ||
        nativeBrowserOptions?.blocklist?.length)
    ) {
      throw new Error(
        'Configure allowlist and blocklist through security when security is enabled',
      );
    }

    this.#options = options;
    this.#maxConcurrency = maxConcurrency;
    this.#taskTimeout = taskTimeout;
    this.#queue = new TaskQueue({ maxConcurrency, maxQueueSize });
  }

  get stats(): RendererStats {
    return {
      ...this.#queue.stats,
      closing: Boolean(this.#closing),
      succeeded: this.#succeeded,
      failed: this.#failed,
    };
  }

  image(
    options: ImageRenderOptions & {
      output: ScreenshotOptions & { encoding: 'base64' };
    },
  ): Promise<string>;
  image(options: ImageRenderOptions): Promise<Uint8Array>;
  async image(options: ImageRenderOptions): Promise<string | Uint8Array> {
    return (await this.imageResult(options)).data;
  }

  imageResult(
    options: ImageRenderOptions & {
      output: ScreenshotOptions & { encoding: 'base64' };
    },
  ): Promise<RenderResult<string>>;
  imageResult(options: ImageRenderOptions): Promise<RenderResult<Uint8Array>>;
  async imageResult(
    options: ImageRenderOptions,
  ): Promise<RenderResult<string | Uint8Array>> {
    return this.#withPage(options, async page => {
      if (options.selector) {
        const element = await page.waitForSelector(
          options.selector,
          options.selectorOptions,
        );
        if (!element) {
          throw new Error(`Element was not found: ${options.selector}`);
        }
        return element.screenshot(options.output);
      }
      return page.screenshot({ fullPage: true, ...options.output });
    });
  }

  async pdf(options: PdfRenderOptions): Promise<Uint8Array> {
    return (await this.pdfResult(options)).data;
  }

  async pdfResult(
    options: PdfRenderOptions,
  ): Promise<RenderResult<Uint8Array>> {
    return this.#withPage(options, page => page.pdf(options.output));
  }

  async evaluate<T>(options: EvaluateOptions<T>): Promise<T> {
    return (await this.evaluateResult(options)).data;
  }

  async evaluateResult<T>(
    options: EvaluateOptions<T>,
  ): Promise<RenderResult<T>> {
    return this.#withPage(options, page => options.evaluate(page));
  }

  async batch(
    tasks: readonly RendererBatchTask[],
    options: RendererBatchOptions = {},
  ): Promise<RendererBatchResult[]> {
    const concurrency = Math.min(
      options.concurrency ?? this.#maxConcurrency,
      Math.max(tasks.length, 1),
    );
    this.#validateInteger('batch concurrency', concurrency, 1);
    const results = Array.from<RendererBatchResult>({ length: tasks.length });
    let nextIndex = 0;
    let completed = 0;

    const worker = async () => {
      while (nextIndex < tasks.length) {
        const index = nextIndex;
        nextIndex += 1;
        const task = tasks[index];
        const signal = this.#combineSignals(
          task.options.signal,
          options.signal,
        );
        try {
          const result = await this.#executeBatchTask(task, signal);
          results[index] = {
            id: task.id,
            index,
            status: 'fulfilled',
            result,
          };
        } catch (error) {
          results[index] = {
            id: task.id,
            index,
            status: 'rejected',
            error,
          };
        }

        completed += 1;
        if (options.onProgress) {
          await Promise.resolve(
            options.onProgress(completed, tasks.length),
          ).catch(() => undefined);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
  }

  async close(options: RendererCloseOptions = {}): Promise<void> {
    if (options.force && !this.#shutdown.signal.aborted) {
      this.#shutdown.abort(new RendererClosedError());
    }
    if (this.#closing) {
      return this.#closing;
    }

    this.#queue.stopAccepting();
    this.#closing = (async () => {
      await this.#queue.onIdle();
      const browser =
        this.#browser ?? (await this.#launching?.catch(() => undefined));
      this.#browser = undefined;
      if (browser?.connected) {
        if (this.#ownsBrowser) {
          await browser.close();
        } else {
          await browser.disconnect();
        }
      }
      this.#closed = true;
    })();

    return this.#closing;
  }

  async #getBrowser(): Promise<Browser> {
    if (this.#closed) {
      throw new RendererClosedError();
    }
    if (this.#browser?.connected) {
      return this.#browser;
    }
    if (this.#launching) {
      const browser = await this.#launching;
      if (this.#closed) {
        throw new RendererClosedError();
      }
      return browser;
    }

    this.#launching = this.#openBrowser();
    try {
      const browser = await this.#launching;
      if (this.#closed) {
        throw new RendererClosedError();
      }
      this.#browser = browser;
      this.#observeBrowser(browser);
      return browser;
    } finally {
      this.#launching = undefined;
    }
  }

  async #openBrowser(): Promise<Browser> {
    const securityOptions = getBrowserSecurityOptions(this.#options.security);
    if (this.#options.connectOptions) {
      try {
        const browser = await connect({
          ...this.#options.connectOptions,
          ...securityOptions,
        });
        this.#ownsBrowser = false;
        this.#emit({ type: 'browser.connected' });
        return browser;
      } catch (cause) {
        throw new Error('Failed to connect to remote Chrome', { cause });
      }
    }

    let executablePath =
      this.#options.executablePath ?? process.env.PPTR_EXECUTABLE_PATH;
    const { launchOptions = {} } = this.#options;

    if (!executablePath && !launchOptions.channel) {
      executablePath = (await resolveManagedBrowser(this.#options.browser))
        .executablePath;
    }
    if (executablePath) {
      try {
        await access(executablePath);
      } catch (cause) {
        throw new Error(
          `Chrome executable was not found at ${executablePath}`,
          {
            cause,
          },
        );
      }
    }

    try {
      const browser = await launch({
        ...launchOptions,
        ...securityOptions,
        executablePath,
      });
      this.#ownsBrowser = true;
      this.#emit({ type: 'browser.launched' });
      return browser;
    } catch (cause) {
      throw new Error('Failed to launch Chrome', { cause });
    }
  }

  async #withPage<T>(
    options: RenderPageOptions,
    operation: (page: Page) => Awaitable<T>,
  ): Promise<RenderResult<T>> {
    validateSource(options.source);
    if (isUrlSource(options.source)) {
      assertNavigationAllowed(options.source.url, this.#options.security);
    }
    const timeout = options.timeout ?? this.#taskTimeout;
    this.#validateInteger('timeout', timeout, 0);
    this.#validateRetry(options.retry === false ? undefined : options.retry);
    const taskId = options.taskId?.trim() || randomUUID();
    const queuedAt = Date.now();
    let startedAt = queuedAt;
    const taskSignal = createTaskSignal({
      caller: options.signal,
      shutdown: this.#shutdown.signal,
      timeout,
    });
    this.#emit({ type: 'task.queued', taskId });

    try {
      const result = await this.#queue.enqueue(() => {
        startedAt = Date.now();
        this.#emit({ type: 'task.started', taskId, attempt: 1 });
        return this.#runPageWithRetry(
          options,
          operation,
          taskSignal.signal,
          taskId,
        );
      }, taskSignal.signal);
      const finishedAt = Date.now();
      this.#succeeded += 1;
      this.#emit({
        type: 'task.succeeded',
        taskId,
        attempt: result.attempts,
      });
      return {
        data: result.data,
        metadata: {
          taskId,
          attempts: result.attempts,
          queuedAt,
          startedAt,
          finishedAt,
          queueDuration: startedAt - queuedAt,
          renderDuration: finishedAt - startedAt,
          totalDuration: finishedAt - queuedAt,
          finalUrl: result.finalUrl,
          statusCode: result.statusCode,
          pageErrors: result.pageErrors,
          network: result.network,
        },
      };
    } catch (error) {
      this.#failed += 1;
      this.#emit({ type: 'task.failed', taskId, error });
      throw error;
    } finally {
      taskSignal.dispose();
    }
  }

  async #runPageWithRetry<T>(
    options: RenderPageOptions,
    operation: (page: Page) => Awaitable<T>,
    signal: AbortSignal,
    taskId: string,
  ): Promise<RetriedPageResult<T>> {
    const retry = this.#resolveRetry(options.retry);
    let attempt = 0;

    while (attempt < retry.maxAttempts) {
      attempt += 1;
      try {
        const result = await this.#runPageAttempt(options, operation, signal);
        return { ...result, attempts: attempt };
      } catch (error) {
        const retryAllowed =
          attempt < retry.maxAttempts &&
          !signal.aborted &&
          !(error instanceof RendererError) &&
          (retry.shouldRetry ? await retry.shouldRetry(error, attempt) : true);
        if (!retryAllowed) {
          throw error;
        }

        this.#emit({ type: 'task.retry', taskId, attempt, error });
        const delay = Math.min(
          retry.maxDelay,
          retry.delay * retry.backoff ** (attempt - 1),
        );
        if (delay > 0) {
          await this.#delay(delay, signal);
        }
      }
    }

    throw new Error('Renderer retry loop ended unexpectedly');
  }

  async #runPageAttempt<T>(
    options: RenderPageOptions,
    operation: (page: Page) => Awaitable<T>,
    signal: AbortSignal,
  ): Promise<PageAttemptResult<T>> {
    const browser = await raceWithSignal(this.#getBrowser(), signal);
    signal.throwIfAborted();
    const context = await raceWithSignal(
      browser.createBrowserContext({
        ...this.#options.contextOptions,
        ...options.contextOptions,
      }),
      signal,
    );

    try {
      const page = await raceWithSignal(context.newPage(), signal);
      const pageErrors: string[] = [];
      page.on('pageerror', error => {
        pageErrors.push(error instanceof Error ? error.message : String(error));
      });
      const network = await setupPageNetwork(
        page,
        options.network
          ? { ...this.#options.network, ...options.network }
          : this.#options.network,
        this.#options.security,
      );

      try {
        const execution = (async (): Promise<PageAttemptResult<T>> => {
          const response = await this.#preparePage(page, options, signal);
          const data = await operation(page);
          return {
            data,
            finalUrl: page.url(),
            statusCode: response?.status(),
            pageErrors,
            network: { ...network.stats },
          };
        })();
        return await raceWithSignal(
          Promise.race([execution, network.failure]),
          signal,
        );
      } finally {
        await network.dispose();
      }
    } finally {
      if (!context.closed) {
        await context.close().catch(() => undefined);
      }
    }
  }

  async #preparePage(
    page: Page,
    options: RenderPageOptions,
    signal: AbortSignal,
  ): Promise<HTTPResponse | null> {
    const deterministic = resolveDeterministicOptions(
      options.deterministic ?? this.#options.deterministic,
    );

    await page.setViewport(options.viewport ?? getDefaultViewport());
    await prepareDeterministicPage(page, deterministic);

    if (options.userAgent) {
      await page.setUserAgent({ userAgent: options.userAgent });
    }
    const headers = {
      ...getDeterministicHeaders(deterministic),
      ...options.headers,
    };
    if (Object.keys(headers).length > 0) {
      await page.setExtraHTTPHeaders(headers);
    }
    if (options.cookies?.length) {
      await page.browserContext().setCookie(...options.cookies);
    }

    await options.beforeNavigate?.(page);

    let response: HTTPResponse | null = null;
    if (isUrlSource(options.source)) {
      response = await page.goto(options.source.url, {
        waitUntil: 'domcontentloaded',
        ...options.navigation,
        signal,
      });
    } else {
      await page.setContent(options.source.html, {
        waitUntil: 'domcontentloaded',
        ...options.content,
        signal,
      });
    }

    await options.afterNavigate?.(page);
    await waitForDeterministicPage(page, deterministic);
    await this.#waitUntilReady(page, options.wait, signal);
    return response;
  }

  async #waitUntilReady(
    page: Page,
    wait: RenderWaitOptions | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (wait?.selector) {
      await page.waitForSelector(wait.selector, wait.selectorOptions);
    }
    if (wait?.networkIdle) {
      await page.waitForNetworkIdle(
        wait.networkIdle === true
          ? { signal }
          : { ...wait.networkIdle, signal },
      );
    }
    if (wait?.fonts) {
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
    }
  }

  async #executeBatchTask(
    task: RendererBatchTask,
    signal: AbortSignal | undefined,
  ): Promise<RenderResult<unknown>> {
    const taskId = task.options.taskId ?? task.id;
    switch (task.type) {
      case 'image':
        return this.imageResult({ ...task.options, signal, taskId });
      case 'pdf':
        return this.pdfResult({ ...task.options, signal, taskId });
      case 'evaluate':
        return this.evaluateResult({ ...task.options, signal, taskId });
    }
  }

  #combineSignals(
    first: AbortSignal | undefined,
    second: AbortSignal | undefined,
  ): AbortSignal | undefined {
    if (!first) {
      return second;
    }
    if (!second) {
      return first;
    }
    return AbortSignal.any([first, second]);
  }

  #resolveRetry(taskRetry: RenderPageOptions['retry']): ResolvedRetryOptions {
    if (taskRetry === false) {
      return { maxAttempts: 1, delay: 100, backoff: 2, maxDelay: 2_000 };
    }
    const retry = {
      ...this.#options.retry,
      ...taskRetry,
    };
    return {
      maxAttempts: retry.maxAttempts ?? 1,
      delay: retry.delay ?? 100,
      backoff: retry.backoff ?? 2,
      maxDelay: retry.maxDelay ?? 2_000,
      shouldRetry: retry.shouldRetry,
    };
  }

  async #delay(delay: number, signal: AbortSignal): Promise<void> {
    const waiting = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, delay);
      timer.unref();
    });
    await raceWithSignal(waiting, signal);
  }

  #observeBrowser(browser: Browser): void {
    browser.once('disconnected', () => {
      if (this.#browser === browser) {
        this.#browser = undefined;
      }
      this.#emit({ type: 'browser.disconnected' });
    });
  }

  #emit(event: Omit<RendererEvent, 'timestamp'>): void {
    if (!this.#options.onEvent) {
      return;
    }
    void Promise.resolve(
      this.#options.onEvent({ ...event, timestamp: Date.now() }),
    ).catch(() => undefined);
  }

  #validateRetry(retry: RendererRetryOptions | undefined): void {
    if (!retry) {
      return;
    }
    this.#validateInteger('retry.maxAttempts', retry.maxAttempts ?? 1, 1);
    this.#validateInteger('retry.delay', retry.delay ?? 100, 0);
    this.#validateInteger('retry.maxDelay', retry.maxDelay ?? 2_000, 0);
    const backoff = retry.backoff ?? 2;
    if (!Number.isFinite(backoff) || backoff < 1) {
      throw new Error(
        'retry.backoff must be a finite number greater than or equal to 1',
      );
    }
  }

  #validateInteger(name: string, value: number, minimum: number): void {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(
        `${name} must be an integer greater than or equal to ${minimum}`,
      );
    }
  }
}

export const createRenderer = (options: RendererOptions = {}): Renderer =>
  new PuppeteerRenderer(options);
