import {
  type ConsoleMessage,
  type HTTPRequest,
  type HTTPResponse,
  type Page,
  type ScreenshotOptions,
} from 'puppeteer-core';

export interface PageDiagnosticsOptions {
  console?: boolean;
  failedRequests?: boolean;
  redirects?: boolean;
  har?: boolean;
  html?: boolean;
  mhtml?: boolean;
  /** Save a best-effort screenshot when an attempt fails. A path is required. */
  failureScreenshot?: ScreenshotOptions & { path: string };
}

export interface ConsoleDiagnostic {
  location?: { columnNumber?: number; lineNumber?: number; url?: string };
  text: string;
  timestamp: number;
  type: string;
}

export interface FailedRequestDiagnostic {
  errorText?: string;
  method: string;
  resourceType: string;
  timestamp: number;
  url: string;
}

export interface RedirectDiagnostic {
  from: string;
  status?: number;
  timestamp: number;
  to: string;
}

export interface PageDiagnostics {
  console?: ConsoleDiagnostic[];
  failedRequests?: FailedRequestDiagnostic[];
  redirects?: RedirectDiagnostic[];
}

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    bodySize: number;
    headers: HarHeader[];
    headersSize: number;
    httpVersion: string;
    method: string;
    queryString: HarHeader[];
    url: string;
  };
  response: {
    bodySize: number;
    content: { mimeType: string; size: number };
    cookies: never[];
    headers: HarHeader[];
    headersSize: number;
    httpVersion: string;
    redirectURL: string;
    status: number;
    statusText: string;
  };
  cache: Record<string, never>;
  timings: { connect: number; receive: number; send: number; wait: number };
}

export interface HarArtifact {
  log: {
    creator: { name: string; version: string };
    entries: HarEntry[];
    version: string;
  };
}

export interface RenderArtifacts {
  har?: HarArtifact;
  html?: string;
  mhtml?: string;
}

export interface PageDiagnosticsSession {
  readonly diagnostics: PageDiagnostics;
  captureArtifacts(): Promise<RenderArtifacts | undefined>;
  captureFailureScreenshot(): Promise<void>;
  dispose(): Promise<void>;
}

const headersToArray = (headers: Record<string, string>): HarHeader[] =>
  Object.entries(headers).map(([name, value]) => ({ name, value }));

const queryToArray = (rawUrl: string): HarHeader[] => {
  try {
    return Array.from(new URL(rawUrl).searchParams, ([name, value]) => ({
      name,
      value,
    }));
  } catch {
    return [];
  }
};

const createHarEntry = (request: HTTPRequest): HarEntry => {
  const startedAt = Date.now();
  return {
    startedDateTime: new Date(startedAt).toISOString(),
    time: 0,
    request: {
      bodySize: Buffer.byteLength(request.postData() ?? ''),
      headers: headersToArray(request.headers()),
      headersSize: -1,
      httpVersion: 'HTTP/1.1',
      method: request.method(),
      queryString: queryToArray(request.url()),
      url: request.url(),
    },
    response: {
      bodySize: -1,
      content: { mimeType: '', size: -1 },
      cookies: [],
      headers: [],
      headersSize: -1,
      httpVersion: 'HTTP/1.1',
      redirectURL: '',
      status: 0,
      statusText: '',
    },
    cache: {},
    timings: { connect: -1, receive: 0, send: 0, wait: 0 },
  };
};

export const setupPageDiagnostics = (
  page: Page,
  options: PageDiagnosticsOptions | undefined,
): PageDiagnosticsSession => {
  const diagnostics: PageDiagnostics = {};
  const harEntries: HarEntry[] = [];
  const harByRequest = new Map<HTTPRequest, HarEntry>();
  const redirectKeys = new Set<string>();

  if (options?.console) {
    diagnostics.console = [];
  }
  if (options?.failedRequests) {
    diagnostics.failedRequests = [];
  }
  if (options?.redirects) {
    diagnostics.redirects = [];
  }

  const onConsole = (message: ConsoleMessage) => {
    if (!diagnostics.console) {
      return;
    }
    const location = message.location();
    diagnostics.console.push({
      location: Object.keys(location).length ? location : undefined,
      text: message.text(),
      timestamp: Date.now(),
      type: message.type(),
    });
  };
  const onRequest = (request: HTTPRequest) => {
    if (options?.har) {
      const entry = createHarEntry(request);
      harEntries.push(entry);
      harByRequest.set(request, entry);
    }
    if (!diagnostics.redirects) {
      return;
    }
    const previous = request.redirectChain().at(-1);
    if (!previous) {
      return;
    }
    const key = `${previous.url()}\n${request.url()}`;
    if (redirectKeys.has(key)) {
      return;
    }
    redirectKeys.add(key);
    diagnostics.redirects.push({
      from: previous.url(),
      status: previous.response()?.status(),
      timestamp: Date.now(),
      to: request.url(),
    });
  };
  const onResponse = (response: HTTPResponse) => {
    const entry = harByRequest.get(response.request());
    if (!entry) {
      return;
    }
    const headers = response.headers();
    const contentLength = Number(headers['content-length']);
    entry.response = {
      bodySize: Number.isFinite(contentLength) ? contentLength : -1,
      content: {
        mimeType: headers['content-type'] ?? '',
        size: Number.isFinite(contentLength) ? contentLength : -1,
      },
      cookies: [],
      headers: headersToArray(headers),
      headersSize: -1,
      httpVersion: 'HTTP/1.1',
      redirectURL: headers.location ?? '',
      status: response.status(),
      statusText: response.statusText(),
    };
  };
  const finishHarEntry = (request: HTTPRequest) => {
    const entry = harByRequest.get(request);
    if (!entry) {
      return;
    }
    entry.time = Math.max(
      0,
      Date.now() - new Date(entry.startedDateTime).getTime(),
    );
    entry.timings.wait = entry.time;
  };
  const onRequestFailed = (request: HTTPRequest) => {
    if (diagnostics.failedRequests) {
      diagnostics.failedRequests.push({
        errorText: request.failure()?.errorText,
        method: request.method(),
        resourceType: request.resourceType(),
        timestamp: Date.now(),
        url: request.url(),
      });
    }
    finishHarEntry(request);
  };

  page.on('console', onConsole);
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', finishHarEntry);
  page.on('requestfailed', onRequestFailed);

  return {
    diagnostics,
    async captureArtifacts() {
      if (!options?.har && !options?.html && !options?.mhtml) {
        return undefined;
      }
      const artifacts: RenderArtifacts = {};
      if (options.html) {
        artifacts.html = await page.content();
      }
      if (options.mhtml) {
        const session = await page.createCDPSession();
        try {
          artifacts.mhtml = (
            await session.send('Page.captureSnapshot', { format: 'mhtml' })
          ).data;
        } finally {
          await session.detach().catch(() => undefined);
        }
      }
      if (options.har) {
        artifacts.har = {
          log: {
            creator: { name: 'pptr-helper', version: '1.0' },
            entries: harEntries,
            version: '1.2',
          },
        };
      }
      return artifacts;
    },
    async captureFailureScreenshot() {
      if (!options?.failureScreenshot || page.isClosed()) {
        return;
      }
      await Promise.race([
        page.screenshot({
          fullPage: true,
          ...options.failureScreenshot,
        }),
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref();
        }),
      ]).catch(() => undefined);
    },
    async dispose() {
      page.off('console', onConsole);
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', finishHarEntry);
      page.off('requestfailed', onRequestFailed);
    },
  };
};
