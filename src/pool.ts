import { RendererClosedError } from './errors';
import {
  createRenderer,
  type EvaluateOptions,
  type ImageRenderOptions,
  type PdfRenderOptions,
  type RenderResult,
  type Renderer,
  type RendererBatchOptions,
  type RendererBatchResult,
  type RendererBatchTask,
  type RendererCloseOptions,
  type RendererOptions,
  type RendererStats,
  type VisualCompareOptions,
} from './renderer';
import { type PngComparisonResult } from './visual';

export interface RendererPoolOptions {
  size: number;
  /** Retire an idle renderer after this many tasks. Use 0 to disable. */
  maxTasksPerBrowser?: number;
  renderer?: RendererOptions;
}

export interface RendererPoolStats extends RendererStats {
  recycling: number;
  size: number;
}

export interface RendererPool extends Renderer {
  readonly stats: RendererPoolStats;
}

interface PoolSlot {
  completed: number;
  recycling?: Promise<void>;
  renderer: Renderer;
  reservations: number;
}

class PuppeteerRendererPool implements RendererPool {
  readonly #options: RendererPoolOptions;
  readonly #slots: PoolSlot[];
  readonly #maxConcurrency: number;
  readonly #maxQueueSize: number;
  #closed = false;
  #succeeded = 0;
  #failed = 0;

  constructor(options: RendererPoolOptions) {
    this.#validateInteger('size', options.size, 1);
    this.#validateInteger(
      'maxTasksPerBrowser',
      options.maxTasksPerBrowser ?? 0,
      0,
    );
    this.#options = options;
    this.#maxConcurrency =
      (options.renderer?.maxConcurrency ?? 4) * options.size;
    this.#maxQueueSize = (options.renderer?.maxQueueSize ?? 100) * options.size;
    this.#slots = Array.from({ length: options.size }, () => ({
      completed: 0,
      renderer: createRenderer(options.renderer),
      reservations: 0,
    }));
  }

  get stats(): RendererPoolStats {
    return {
      active: this.#slots.reduce(
        (total, slot) => total + slot.renderer.stats.active,
        0,
      ),
      pending: this.#slots.reduce(
        (total, slot) => total + slot.renderer.stats.pending,
        0,
      ),
      maxConcurrency: this.#maxConcurrency,
      maxQueueSize: this.#maxQueueSize,
      closing: this.#closed,
      succeeded: this.#succeeded,
      failed: this.#failed,
      recycling: this.#slots.filter(slot => slot.recycling).length,
      size: this.#slots.length,
    };
  }

  image(
    options: ImageRenderOptions & {
      output: NonNullable<ImageRenderOptions['output']> & {
        encoding: 'base64';
      };
    },
  ): Promise<string>;
  image(options: ImageRenderOptions): Promise<Uint8Array>;
  async image(options: ImageRenderOptions): Promise<string | Uint8Array> {
    return this.#run(renderer => renderer.image(options));
  }

  imageResult(
    options: ImageRenderOptions & {
      output: NonNullable<ImageRenderOptions['output']> & {
        encoding: 'base64';
      };
    },
  ): Promise<RenderResult<string>>;
  imageResult(options: ImageRenderOptions): Promise<RenderResult<Uint8Array>>;
  async imageResult(
    options: ImageRenderOptions,
  ): Promise<RenderResult<string | Uint8Array>> {
    return this.#run(renderer => renderer.imageResult(options));
  }

  async pdf(options: PdfRenderOptions): Promise<Uint8Array> {
    return this.#run(renderer => renderer.pdf(options));
  }

  async pdfResult(
    options: PdfRenderOptions,
  ): Promise<RenderResult<Uint8Array>> {
    return this.#run(renderer => renderer.pdfResult(options));
  }

  async compare(options: VisualCompareOptions): Promise<PngComparisonResult> {
    return this.#run(renderer => renderer.compare(options));
  }

  async compareResult(
    options: VisualCompareOptions,
  ): Promise<RenderResult<PngComparisonResult>> {
    return this.#run(renderer => renderer.compareResult(options));
  }

  async evaluate<T>(options: EvaluateOptions<T>): Promise<T> {
    return this.#run(renderer => renderer.evaluate(options));
  }

  async evaluateResult<T>(
    options: EvaluateOptions<T>,
  ): Promise<RenderResult<T>> {
    return this.#run(renderer => renderer.evaluateResult(options));
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
          results[index] = {
            id: task.id,
            index,
            result: await this.#executeBatchTask(task, signal),
            status: 'fulfilled',
          };
        } catch (error) {
          results[index] = {
            error,
            id: task.id,
            index,
            status: 'rejected',
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
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.all(
      this.#slots.map(async slot => {
        await slot.recycling?.catch(() => undefined);
        await slot.renderer.close(options);
      }),
    );
  }

  async #run<T>(operation: (renderer: Renderer) => Promise<T>): Promise<T> {
    const slot = this.#reserveAvailableSlot() ?? (await this.#waitForSlot());
    let operationPromise: Promise<T>;
    try {
      operationPromise = operation(slot.renderer);
    } finally {
      slot.reservations -= 1;
    }
    try {
      const result = await operationPromise;
      this.#succeeded += 1;
      return result;
    } catch (error) {
      this.#failed += 1;
      throw error;
    } finally {
      slot.completed += 1;
      this.#recycleIfNeeded(slot);
    }
  }

  #reserveAvailableSlot(): PoolSlot | undefined {
    if (this.#closed) {
      throw new RendererClosedError();
    }
    const available = this.#slots.filter(slot => !slot.recycling);
    if (!available.length) {
      return undefined;
    }
    const selected = available.reduce((best, slot) =>
      this.#slotLoad(slot) < this.#slotLoad(best) ? slot : best,
    );
    selected.reservations += 1;
    return selected;
  }

  async #waitForSlot(): Promise<PoolSlot> {
    while (true) {
      const selected = this.#reserveAvailableSlot();
      if (selected) {
        return selected;
      }
      await Promise.race(
        this.#slots
          .map(slot => slot.recycling)
          .filter((recycling): recycling is Promise<void> =>
            Boolean(recycling),
          ),
      );
    }
  }

  #slotLoad(slot: PoolSlot): number {
    return (
      slot.renderer.stats.active +
      slot.renderer.stats.pending +
      slot.reservations
    );
  }

  #recycleIfNeeded(slot: PoolSlot): void {
    const maximum = this.#options.maxTasksPerBrowser ?? 0;
    if (
      this.#closed ||
      maximum === 0 ||
      slot.completed < maximum ||
      slot.recycling ||
      slot.renderer.stats.active > 0 ||
      slot.renderer.stats.pending > 0
    ) {
      return;
    }
    slot.recycling = (async () => {
      await slot.renderer.close();
      if (!this.#closed) {
        slot.renderer = createRenderer(this.#options.renderer);
        slot.completed = 0;
      }
    })().finally(() => {
      slot.recycling = undefined;
    });
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
      case 'compare':
        return this.compareResult({ ...task.options, signal, taskId });
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

  #validateInteger(name: string, value: number, minimum: number): void {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(
        `${name} must be an integer greater than or equal to ${minimum}`,
      );
    }
  }
}

export const createRendererPool = (
  options: RendererPoolOptions,
): RendererPool => new PuppeteerRendererPool(options);
