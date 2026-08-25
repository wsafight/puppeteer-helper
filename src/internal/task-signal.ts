import {
  RendererAbortError,
  RendererError,
  RendererTimeoutError,
} from '../errors';

export interface TaskSignalOptions {
  caller?: AbortSignal;
  shutdown: AbortSignal;
  timeout: number;
}

export interface TaskSignal {
  signal: AbortSignal;
  dispose(): void;
}

const normalizeAbortReason = (signal: AbortSignal): Error => {
  if (signal.reason instanceof RendererError) {
    return signal.reason;
  }
  return new RendererAbortError(undefined, { cause: signal.reason });
};

export const createTaskSignal = ({
  caller,
  shutdown,
  timeout,
}: TaskSignalOptions): TaskSignal => {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];

  const forward = (source: AbortSignal) => {
    const abort = () => controller.abort(normalizeAbortReason(source));
    if (source.aborted) {
      abort();
      return;
    }
    source.addEventListener('abort', abort, { once: true });
    listeners.push(() => source.removeEventListener('abort', abort));
  };

  if (caller) {
    forward(caller);
  }
  forward(shutdown);

  const timer =
    timeout > 0
      ? setTimeout(
          () => controller.abort(new RendererTimeoutError(timeout)),
          timeout,
        )
      : undefined;
  timer?.unref();

  return {
    signal: controller.signal,
    dispose() {
      if (timer) {
        clearTimeout(timer);
      }
      for (const removeListener of listeners) {
        removeListener();
      }
    },
  };
};

export const raceWithSignal = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  signal.throwIfAborted();

  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(normalizeAbortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });

  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbortListener();
  }
};
