import { afterEach, describe, expect, test, vi } from 'vitest';

import { TaskAdmissionController } from '../src/scheduler';

afterEach(() => {
  vi.useRealTimers();
});

describe('TaskAdmissionController', () => {
  test('limits active work independently by hostname and tenant', async () => {
    const controller = new TaskAdmissionController({
      maxConcurrencyPerHost: 1,
      maxConcurrencyPerTenant: 1,
    });
    const signal = new AbortController().signal;
    const releaseFirst = await controller.acquire(
      { host: 'a.example', tenantId: 'tenant-a' },
      signal,
    );
    let sameHostAcquired = false;
    let sameTenantAcquired = false;
    const sameHost = controller
      .acquire({ host: 'a.example', tenantId: 'tenant-b' }, signal)
      .then(release => {
        sameHostAcquired = true;
        return release;
      });
    const sameTenant = controller
      .acquire({ host: 'b.example', tenantId: 'tenant-a' }, signal)
      .then(release => {
        sameTenantAcquired = true;
        return release;
      });

    await Promise.resolve();
    expect(sameHostAcquired).toBe(false);
    expect(sameTenantAcquired).toBe(false);

    releaseFirst();
    const [releaseHost, releaseTenant] = await Promise.all([
      sameHost,
      sameTenant,
    ]);
    releaseHost();
    releaseTenant();
  });

  test('enforces the minimum interval between hostname starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const controller = new TaskAdmissionController({ minHostInterval: 50 });
    const signal = new AbortController().signal;
    const releaseFirst = await controller.acquire(
      { host: 'example.com' },
      signal,
    );
    releaseFirst();

    let acquired = false;
    const second = controller
      .acquire({ host: 'example.com' }, signal)
      .then(release => {
        acquired = true;
        return release;
      });
    await vi.advanceTimersByTimeAsync(49);
    expect(acquired).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const releaseSecond = await second;
    expect(acquired).toBe(true);
    releaseSecond();
  });

  test('rejects an admission wait when its signal is aborted', async () => {
    const controller = new TaskAdmissionController({
      maxConcurrencyPerHost: 1,
    });
    const release = await controller.acquire(
      { host: 'example.com' },
      new AbortController().signal,
    );
    const abort = new AbortController();
    const reason = new Error('stop waiting');
    const waiting = controller.acquire({ host: 'example.com' }, abort.signal);

    abort.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    release();
  });
});
