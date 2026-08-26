import { describe, expect, test } from 'vitest';

import { RendererAbortError } from '../src/errors';
import { raceWithSignalAndCleanup } from '../src/internal/task-signal';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

describe('task signals', () => {
  test('cleans up a resource that resolves after cancellation', async () => {
    const resource = { closed: false };
    const operation = deferred<typeof resource>();
    const cleaned = deferred<void>();
    const controller = new AbortController();
    const raced = raceWithSignalAndCleanup(
      operation.promise,
      controller.signal,
      value => {
        value.closed = true;
        cleaned.resolve();
      },
    );

    controller.abort();
    await expect(raced).rejects.toBeInstanceOf(RendererAbortError);

    operation.resolve(resource);
    await cleaned.promise;
    expect(resource.closed).toBe(true);
  });
});
