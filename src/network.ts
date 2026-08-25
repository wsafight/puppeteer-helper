import { isIP } from 'node:net';

import {
  type CDPSession,
  type ContinueRequestOverrides,
  type Credentials,
  type HTTPRequest,
  type HTTPResponse,
  type Page,
  type ResourceType,
} from 'puppeteer-core';

import { RendererSecurityError } from './errors';

type Awaitable<T> = T | Promise<T>;

export type NetworkRequestDecision =
  | 'abort'
  | 'continue'
  | { action: 'abort' }
  | { action: 'continue'; overrides?: ContinueRequestOverrides };

export interface NetworkOptions {
  /** Abort matching resource categories before they are downloaded. */
  blockedResourceTypes?: ResourceType[];
  /** Abort URLs matching these glob patterns. `*` matches any characters. */
  blockedUrls?: string[];
  /** HTTP basic authentication credentials, including proxy credentials. */
  credentials?: Credentials;
  offline?: boolean;
  /** Inspect, abort, or rewrite individual requests. */
  onRequest?: (
    request: HTTPRequest,
  ) => Awaitable<NetworkRequestDecision | void>;
}

export interface RendererSecurityOptions {
  /** Chrome URLPattern entries allowed to load. Cannot be combined with blocklist. */
  allowlist?: string[];
  /** Chrome URLPattern entries blocked from loading. */
  blocklist?: string[];
  /** Allow loopback, link-local, and private response addresses. @defaultValue false */
  allowPrivateNetwork?: boolean;
  /** Allowed top-level navigation protocols. @defaultValue http:, https: */
  allowedProtocols?: string[];
  /** Maximum requests issued by one rendering attempt. */
  maxRequests?: number;
  /** Maximum encoded response bytes transferred by one rendering attempt. */
  maxTotalResponseBytes?: number;
}

export interface NetworkStats {
  requests: number;
  responses: number;
  /** Collected when maxTotalResponseBytes is enabled. */
  transferredBytes?: number;
}

export interface PageNetworkSession {
  readonly failure: Promise<never>;
  readonly stats: NetworkStats;
  dispose(): Promise<void>;
}

const PRIVATE_NETWORK_BLOCKLIST = [
  '*://localhost/*',
  '*://*.localhost/*',
  '*://0.*/*',
  '*://10.*/*',
  '*://127.*/*',
  '*://169.254.*/*',
  ...Array.from({ length: 16 }, (_, index) => `*://172.${index + 16}.*/*`),
  '*://192.168.*/*',
];

const normalizeProtocol = (protocol: string): string =>
  protocol.endsWith(':')
    ? protocol.toLowerCase()
    : `${protocol.toLowerCase()}:`;

const validateLimit = (name: string, value: number | undefined): void => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error(`${name} must be a positive integer`);
  }
};

export const validateSecurityOptions = (
  security: RendererSecurityOptions | undefined,
): void => {
  if (!security) {
    return;
  }
  if (security.allowlist?.length && security.blocklist?.length) {
    throw new Error(
      'security.allowlist and security.blocklist cannot be combined',
    );
  }
  validateLimit('security.maxRequests', security.maxRequests);
  validateLimit(
    'security.maxTotalResponseBytes',
    security.maxTotalResponseBytes,
  );
};

export const getBrowserSecurityOptions = (
  security: RendererSecurityOptions | undefined,
): { allowlist?: string[]; blocklist?: string[] } => {
  if (!security) {
    return {};
  }
  if (security.allowlist?.length) {
    return { allowlist: [...security.allowlist] };
  }

  const blocklist = [...(security.blocklist ?? [])];
  if (security.allowPrivateNetwork !== true) {
    blocklist.push(...PRIVATE_NETWORK_BLOCKLIST);
  }
  return blocklist.length ? { blocklist } : {};
};

const isPrivateIpv4 = (ip: string): boolean => {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};

export const isPrivateNetworkAddress = (address: string): boolean => {
  const ip = address.toLowerCase().split('%')[0];
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (mapped.includes('.')) {
      return isPrivateNetworkAddress(mapped);
    }
    const groups = mapped.split(':');
    if (groups.length === 2) {
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      if (
        Number.isInteger(high) &&
        Number.isInteger(low) &&
        high >= 0 &&
        high <= 0xffff &&
        low >= 0 &&
        low <= 0xffff
      ) {
        return isPrivateIpv4(
          [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'),
        );
      }
    }
  }
  const version = isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip);
  }
  if (version !== 6) {
    return false;
  }
  return (
    ip === '::' ||
    ip === '::1' ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    /^fe[89ab]/.test(ip)
  );
};

export const assertNavigationAllowed = (
  rawUrl: string,
  security: RendererSecurityOptions | undefined,
): void => {
  if (!security) {
    return;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (cause) {
    throw new RendererSecurityError(`Navigation URL is invalid: ${rawUrl}`, {
      cause,
    });
  }

  const allowedProtocols = (
    security.allowedProtocols ?? ['http:', 'https:']
  ).map(normalizeProtocol);
  if (!allowedProtocols.includes(url.protocol.toLowerCase())) {
    throw new RendererSecurityError(
      `Navigation protocol is not allowed: ${url.protocol}`,
    );
  }
  if (
    security.allowPrivateNetwork !== true &&
    isPrivateNetworkAddress(url.hostname.replace(/^\[|\]$/g, ''))
  ) {
    throw new RendererSecurityError(
      `Navigation to a private network address is not allowed: ${url.hostname}`,
    );
  }
};

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
  );

const createRequestHandler = (
  options: NetworkOptions | undefined,
  security: RendererSecurityOptions | undefined,
  stats: NetworkStats,
  fail: (error: unknown) => void,
) => {
  const blockedTypes = new Set(options?.blockedResourceTypes ?? []);
  const blockedUrls = (options?.blockedUrls ?? []).map(globToRegExp);

  return async (request: HTTPRequest): Promise<void> => {
    stats.requests += 1;
    if (request.isInterceptResolutionHandled()) {
      return;
    }
    if (security?.maxRequests && stats.requests > security.maxRequests) {
      const error = new RendererSecurityError(
        `Request limit exceeded: ${security.maxRequests}`,
      );
      fail(error);
      await request.abort('blockedbyclient');
      return;
    }
    if (
      blockedTypes.has(request.resourceType()) ||
      blockedUrls.some(pattern => pattern.test(request.url()))
    ) {
      await request.abort('blockedbyclient');
      return;
    }

    try {
      const decision = await options?.onRequest?.(request);
      if (
        decision === 'abort' ||
        (typeof decision === 'object' && decision.action === 'abort')
      ) {
        await request.abort('blockedbyclient');
        return;
      }
      const overrides =
        typeof decision === 'object' && decision.action === 'continue'
          ? decision.overrides
          : undefined;
      await request.continue(overrides);
    } catch (error) {
      fail(error);
      if (!request.isInterceptResolutionHandled()) {
        await request.abort('failed');
      }
    }
  };
};

export const setupPageNetwork = async (
  page: Page,
  options: NetworkOptions | undefined,
  security: RendererSecurityOptions | undefined,
): Promise<PageNetworkSession> => {
  const stats: NetworkStats = {
    requests: 0,
    responses: 0,
  };
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  let failed = false;
  const fail = (error: unknown) => {
    if (!failed) {
      failed = true;
      rejectFailure(error);
    }
  };

  if (options?.credentials) {
    await page.authenticate(options.credentials);
  }
  if (options?.offline !== undefined) {
    await page.setOfflineMode(options.offline);
  }

  const shouldIntercept = Boolean(
    options?.blockedResourceTypes?.length ||
    options?.blockedUrls?.length ||
    options?.onRequest ||
    security?.maxRequests,
  );
  const onRequest = shouldIntercept
    ? createRequestHandler(options, security, stats, fail)
    : () => {
        stats.requests += 1;
      };
  if (shouldIntercept) {
    await page.setRequestInterception(true);
  }
  page.on('request', onRequest);

  const onResponse = (response: HTTPResponse) => {
    stats.responses += 1;
    const address = response.remoteAddress().ip as string | undefined;
    if (
      address &&
      security &&
      security.allowPrivateNetwork !== true &&
      isPrivateNetworkAddress(address)
    ) {
      fail(
        new RendererSecurityError(
          `Response from a private network address was blocked: ${address}`,
        ),
      );
    }
  };
  page.on('response', onResponse);

  let session: CDPSession | undefined;
  let onLoadingFinished:
    ((event: { encodedDataLength: number }) => void) | undefined;
  if (security?.maxTotalResponseBytes) {
    stats.transferredBytes = 0;
    session = await page.createCDPSession();
    await session.send('Network.enable');
    onLoadingFinished = event => {
      stats.transferredBytes =
        (stats.transferredBytes ?? 0) + Math.max(0, event.encodedDataLength);
      if (
        security.maxTotalResponseBytes &&
        stats.transferredBytes > security.maxTotalResponseBytes
      ) {
        fail(
          new RendererSecurityError(
            `Response byte limit exceeded: ${security.maxTotalResponseBytes}`,
          ),
        );
      }
    };
    session.on('Network.loadingFinished', onLoadingFinished);
  }

  return {
    failure,
    stats,
    async dispose() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      if (session && onLoadingFinished) {
        session.off('Network.loadingFinished', onLoadingFinished);
        await session.detach().catch(() => undefined);
      }
    },
  };
};
