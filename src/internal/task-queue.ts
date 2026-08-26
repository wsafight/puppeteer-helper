import { RendererClosedError, RendererQueueFullError } from '../errors';

export interface TaskQueueOptions {
  maxConcurrency: number;
  maxQueueSize: number;
}

export interface TaskQueueStats {
  active: number;
  pending: number;
  maxConcurrency: number;
  maxQueueSize: number;
}

interface QueueEntry {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  removeAbortListener?: () => void;
  priority: number;
  sequence: number;
}

export class TaskQueue {
  readonly #maxConcurrency: number;
  readonly #maxQueueSize: number;
  readonly #pending: QueueEntry[] = [];
  readonly #idleResolvers = new Set<() => void>();
  #active = 0;
  #accepting = true;
  #sequence = 0;

  constructor({ maxConcurrency, maxQueueSize }: TaskQueueOptions) {
    this.#maxConcurrency = maxConcurrency;
    this.#maxQueueSize = maxQueueSize;
  }

  get stats(): TaskQueueStats {
    return {
      active: this.#active,
      pending: this.#pending.length,
      maxConcurrency: this.#maxConcurrency,
      maxQueueSize: this.#maxQueueSize,
    };
  }

  enqueue<T>(
    run: () => Promise<T>,
    signal?: AbortSignal,
    priority = 0,
  ): Promise<T> {
    if (!this.#accepting) {
      return Promise.reject(new RendererClosedError());
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        run,
        resolve: value => resolve(value as T),
        reject,
        signal,
        priority,
        sequence: this.#sequence,
      };
      this.#sequence += 1;

      if (this.#active < this.#maxConcurrency) {
        this.#start(entry);
        return;
      }
      if (this.#pending.length >= this.#maxQueueSize) {
        reject(new RendererQueueFullError(this.#maxQueueSize));
        return;
      }

      if (signal) {
        const onAbort = () => {
          const index = this.#pending.indexOf(entry);
          if (index >= 0) {
            this.#pending.splice(index, 1);
          }
          reject(signal.reason);
          this.#resolveIdleIfNeeded();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.removeAbortListener = () =>
          signal.removeEventListener('abort', onAbort);
      }

      const insertAt = this.#pending.findIndex(
        pending =>
          entry.priority > pending.priority ||
          (entry.priority === pending.priority &&
            entry.sequence < pending.sequence),
      );
      if (insertAt < 0) {
        this.#pending.push(entry);
      } else {
        this.#pending.splice(insertAt, 0, entry);
      }
    });
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  async onIdle(): Promise<void> {
    if (this.#active === 0 && this.#pending.length === 0) {
      return;
    }
    await new Promise<void>(resolve => this.#idleResolvers.add(resolve));
  }

  #start(entry: QueueEntry): void {
    entry.removeAbortListener?.();
    this.#active += 1;

    void (async () => {
      try {
        entry.signal?.throwIfAborted();
        entry.resolve(await entry.run());
      } catch (error) {
        entry.reject(error);
      } finally {
        this.#active -= 1;
        this.#drain();
      }
    })();
  }

  #drain(): void {
    while (this.#active < this.#maxConcurrency && this.#pending.length > 0) {
      const entry = this.#pending.shift();
      if (entry) {
        this.#start(entry);
      }
    }
    this.#resolveIdleIfNeeded();
  }

  #resolveIdleIfNeeded(): void {
    if (this.#active > 0 || this.#pending.length > 0) {
      return;
    }
    for (const resolve of this.#idleResolvers) {
      resolve();
    }
    this.#idleResolvers.clear();
  }
}
