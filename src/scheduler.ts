export interface RendererSchedulerOptions {
  /** Maximum active tasks for one URL hostname. Use 0 to disable. */
  maxConcurrencyPerHost?: number;
  /** Minimum interval between task starts for one URL hostname. */
  minHostInterval?: number;
  /** Maximum active tasks for one tenantId. Use 0 to disable. */
  maxConcurrencyPerTenant?: number;
  /** Maximum completed results retained by resultCache. */
  cacheMaxEntries?: number;
}

export interface TaskAdmission {
  host?: string;
  tenantId?: string;
}

const validateNonNegativeInteger = (
  name: string,
  value: number | undefined,
): void => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
};

export const validateSchedulerOptions = (
  options: RendererSchedulerOptions | undefined,
): void => {
  if (!options) {
    return;
  }
  validateNonNegativeInteger(
    'scheduler.maxConcurrencyPerHost',
    options.maxConcurrencyPerHost,
  );
  validateNonNegativeInteger(
    'scheduler.minHostInterval',
    options.minHostInterval,
  );
  validateNonNegativeInteger(
    'scheduler.maxConcurrencyPerTenant',
    options.maxConcurrencyPerTenant,
  );
  validateNonNegativeInteger(
    'scheduler.cacheMaxEntries',
    options.cacheMaxEntries,
  );
};

export class TaskAdmissionController {
  readonly #options: RendererSchedulerOptions;
  readonly #activeHosts = new Map<string, number>();
  readonly #activeTenants = new Map<string, number>();
  readonly #lastHostStart = new Map<string, number>();
  readonly #waiters = new Set<() => void>();

  constructor(options: RendererSchedulerOptions = {}) {
    validateSchedulerOptions(options);
    this.#options = options;
  }

  async run<T>(
    admission: TaskAdmission,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(admission, signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async acquire(
    admission: TaskAdmission,
    signal: AbortSignal,
  ): Promise<() => void> {
    while (true) {
      signal.throwIfAborted();
      const delay = this.#requiredDelay(admission);
      if (delay === 0 && this.#hasCapacity(admission)) {
        this.#increment(this.#activeHosts, admission.host);
        this.#increment(this.#activeTenants, admission.tenantId);
        if (admission.host) {
          this.#lastHostStart.set(admission.host, Date.now());
        }
        let released = false;
        return () => {
          if (released) {
            return;
          }
          released = true;
          this.#decrement(this.#activeHosts, admission.host);
          this.#decrement(this.#activeTenants, admission.tenantId);
          this.#notify();
        };
      }
      await this.#wait(delay, signal);
    }
  }

  #hasCapacity({ host, tenantId }: TaskAdmission): boolean {
    const hostLimit = this.#options.maxConcurrencyPerHost ?? 0;
    const tenantLimit = this.#options.maxConcurrencyPerTenant ?? 0;
    return (
      (!host ||
        hostLimit === 0 ||
        (this.#activeHosts.get(host) ?? 0) < hostLimit) &&
      (!tenantId ||
        tenantLimit === 0 ||
        (this.#activeTenants.get(tenantId) ?? 0) < tenantLimit)
    );
  }

  #requiredDelay({ host }: TaskAdmission): number {
    const interval = this.#options.minHostInterval ?? 0;
    if (!host || interval === 0) {
      return 0;
    }
    return Math.max(
      0,
      interval - (Date.now() - (this.#lastHostStart.get(host) ?? 0)),
    );
  }

  async #wait(delay: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        this.#waiters.delete(notify);
        signal.removeEventListener('abort', onAbort);
        if (timer) {
          clearTimeout(timer);
        }
      };
      const settle = (operation: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        operation();
      };
      const notify = () => settle(resolve);
      const onAbort = () => settle(() => reject(signal.reason));

      this.#waiters.add(notify);
      signal.addEventListener('abort', onAbort, { once: true });
      if (delay > 0) {
        timer = setTimeout(notify, delay);
        timer.unref();
      }
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  #increment(map: Map<string, number>, key: string | undefined): void {
    if (key) {
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }

  #decrement(map: Map<string, number>, key: string | undefined): void {
    if (!key) {
      return;
    }
    const next = (map.get(key) ?? 1) - 1;
    if (next === 0) {
      map.delete(key);
    } else {
      map.set(key, next);
    }
  }

  #notify(): void {
    for (const notify of this.#waiters) {
      notify();
    }
    this.#waiters.clear();
  }
}
