import { describe, expect, test, vi } from 'vitest';

import {
  composeRendererEventSinks,
  createOpenTelemetryEventSink,
  createRendererMetricsCollector,
  createStructuredLoggerEventSink,
  type OpenTelemetrySpan,
  type RendererEvent,
} from '../src';

const event = (
  type: RendererEvent['type'],
  overrides: Partial<RendererEvent> = {},
): RendererEvent => ({ timestamp: 1_000, type, ...overrides });

describe('observability adapters', () => {
  test('writes structured events at lifecycle-aware log levels', () => {
    const debug = vi.fn();
    const error = vi.fn();
    const warn = vi.fn();
    const sink = createStructuredLoggerEventSink({ debug, error, warn });

    sink(event('task.queued', { taskId: 'task-1' }));
    sink(
      event('task.retry', {
        error: new Error('retry me'),
        taskId: 'task-1',
      }),
    );
    sink(
      event('task.failed', {
        error: new Error('failed'),
        taskId: 'task-1',
      }),
    );

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', type: 'task.queued' }),
      'pptr-helper task.queued',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'retry me' }),
      }),
      'pptr-helper task.retry',
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'failed' }),
      }),
      'pptr-helper task.failed',
    );
  });

  test('collects snapshots and Prometheus counters and gauges', () => {
    const collector = createRendererMetricsCollector();
    collector.onEvent(event('browser.launched'));
    collector.onEvent(event('task.queued', { taskId: 'task-1' }));
    expect(collector.snapshot()).toMatchObject({
      browserLaunched: 1,
      tasksPending: 1,
      tasksQueued: 1,
    });
    collector.onEvent(event('task.started', { taskId: 'task-1' }));
    collector.onEvent(event('task.retry', { taskId: 'task-1' }));
    collector.onEvent(event('task.succeeded', { taskId: 'task-1' }));

    expect(collector.snapshot()).toMatchObject({
      tasksActive: 0,
      tasksPending: 0,
      tasksRetried: 1,
      tasksStarted: 1,
      tasksSucceeded: 1,
    });
    expect(collector.toPrometheus()).toContain(
      'pptr_helper_tasks_total{state="succeeded"} 1',
    );
    expect(collector.toPrometheus()).toContain(
      'pptr_helper_browser_events_total{state="launched"} 1',
    );
  });

  test('tracks concurrent tasks that reuse a task identifier', () => {
    const collector = createRendererMetricsCollector();
    collector.onEvent(event('task.queued', { taskId: 'shared-id' }));
    collector.onEvent(event('task.queued', { taskId: 'shared-id' }));
    collector.onEvent(event('task.started', { taskId: 'shared-id' }));

    expect(collector.snapshot()).toMatchObject({
      tasksActive: 1,
      tasksPending: 1,
    });

    collector.onEvent(event('task.succeeded', { taskId: 'shared-id' }));
    collector.onEvent(event('task.started', { taskId: 'shared-id' }));
    collector.onEvent(event('task.failed', { taskId: 'shared-id' }));
    expect(collector.snapshot()).toMatchObject({
      tasksActive: 0,
      tasksPending: 0,
    });
  });

  test('maps task lifecycle events to OpenTelemetry spans', () => {
    const addEvent = vi.fn();
    const end = vi.fn();
    const recordException = vi.fn();
    const setAttribute = vi.fn();
    const setStatus = vi.fn();
    const span: OpenTelemetrySpan = {
      addEvent,
      end,
      recordException,
      setAttribute,
      setStatus,
    };
    const startSpan = vi.fn(() => span);
    const sink = createOpenTelemetryEventSink({ startSpan });

    sink(event('task.queued', { taskId: 'task-1' }));
    sink(event('task.started', { attempt: 1, taskId: 'task-1' }));
    sink(
      event('task.retry', {
        attempt: 1,
        error: new Error('temporary'),
        taskId: 'task-1',
      }),
    );
    sink(event('task.succeeded', { attempt: 2, taskId: 'task-1' }));

    expect(startSpan).toHaveBeenCalledWith(
      'pptr-helper.render',
      expect.objectContaining({
        attributes: { 'pptr.task.id': 'task-1' },
      }),
    );
    expect(recordException).toHaveBeenCalledWith(expect.any(Error));
    expect(setAttribute).toHaveBeenLastCalledWith('pptr.task.attempts', 2);
    expect(setStatus).toHaveBeenLastCalledWith({ code: 1 });
    expect(end).toHaveBeenCalledWith(1_000);
  });

  test('composes sinks and isolates their failures', async () => {
    const observed: string[] = [];
    const sink = composeRendererEventSinks(
      () => {
        throw new Error('logger unavailable');
      },
      received => {
        observed.push(received.type);
      },
    );

    await expect(sink(event('browser.connected'))).resolves.toBeUndefined();
    expect(observed).toEqual(['browser.connected']);
  });
});
