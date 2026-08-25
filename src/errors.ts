export type RendererErrorCode =
  | 'RENDERER_ABORTED'
  | 'RENDERER_CLOSED'
  | 'RENDERER_QUEUE_FULL'
  | 'RENDERER_SECURITY'
  | 'RENDERER_TIMEOUT';

export class RendererError extends Error {
  readonly code: RendererErrorCode;

  constructor(
    code: RendererErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class RendererAbortError extends RendererError {
  constructor(message = 'Renderer task was aborted', options?: ErrorOptions) {
    super('RENDERER_ABORTED', message, options);
  }
}

export class RendererClosedError extends RendererError {
  constructor() {
    super('RENDERER_CLOSED', 'Renderer is closed');
  }
}

export class RendererQueueFullError extends RendererError {
  readonly maxQueueSize: number;

  constructor(maxQueueSize: number) {
    super(
      'RENDERER_QUEUE_FULL',
      `Renderer queue reached its limit of ${maxQueueSize} pending tasks`,
    );
    this.maxQueueSize = maxQueueSize;
  }
}

export class RendererSecurityError extends RendererError {
  constructor(message: string, options?: ErrorOptions) {
    super('RENDERER_SECURITY', message, options);
  }
}

export class RendererTimeoutError extends RendererError {
  readonly timeout: number;

  constructor(timeout: number) {
    super('RENDERER_TIMEOUT', `Renderer task timed out after ${timeout}ms`);
    this.timeout = timeout;
  }
}
