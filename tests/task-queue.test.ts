import { describe, expect, test } from 'vitest';

import { RendererClosedError, RendererQueueFullError } from '../src/errors';
import { TaskQueue } from '../src/internal/task-queue';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

describe('TaskQueue', () => {
  test('limits concurrency and rejects overflow', async () => {
    const queue = new TaskQueue({ maxConcurrency: 2, maxQueueSize: 1 });
    const first = deferred();
    const second = deferred();

    const firstTask = queue.enqueue(async () => first.promise);
    const secondTask = queue.enqueue(async () => second.promise);
    const thirdTask = queue.enqueue(async () => 'third');

    expect(queue.stats).toMatchObject({ active: 2, pending: 1 });
    await expect(queue.enqueue(async () => 'overflow')).rejects.toBeInstanceOf(
      RendererQueueFullError,
    );

    first.resolve();
    await expect(firstTask).resolves.toBeUndefined();
    await expect(thirdTask).resolves.toBe('third');
    second.resolve();
    await secondTask;
    await queue.onIdle();
    expect(queue.stats).toMatchObject({ active: 0, pending: 0 });
  });

  test('removes an aborted pending task', async () => {
    const queue = new TaskQueue({ maxConcurrency: 1, maxQueueSize: 1 });
    const gate = deferred();
    const active = queue.enqueue(async () => gate.promise);
    const controller = new AbortController();
    const reason = new Error('cancel pending');
    const pending = queue.enqueue(async () => 'pending', controller.signal);

    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(queue.stats.pending).toBe(0);

    gate.resolve();
    await active;
  });

  test('stops accepting new tasks while draining accepted work', async () => {
    const queue = new TaskQueue({ maxConcurrency: 1, maxQueueSize: 1 });
    const gate = deferred();
    const active = queue.enqueue(async () => gate.promise);
    const pending = queue.enqueue(async () => 'drained');

    queue.stopAccepting();
    await expect(queue.enqueue(async () => 'new')).rejects.toBeInstanceOf(
      RendererClosedError,
    );

    gate.resolve();
    await active;
    await expect(pending).resolves.toBe('drained');
    await queue.onIdle();
  });
});
