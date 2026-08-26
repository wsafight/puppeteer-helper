import { type RendererEvent, type RendererEventType } from './renderer';

export type RendererEventSink = (
  event: RendererEvent,
) => void | PromiseLike<void>;

export interface StructuredLogger {
  debug?: (record: Record<string, unknown>, message?: string) => unknown;
  info?: (record: Record<string, unknown>, message?: string) => unknown;
  warn?: (record: Record<string, unknown>, message?: string) => unknown;
  error?: (record: Record<string, unknown>, message?: string) => unknown;
  log?: (record: Record<string, unknown>, message?: string) => unknown;
}

export interface RendererMetricsSnapshot {
  browserConnected: number;
  browserDisconnected: number;
  browserLaunched: number;
  tasksActive: number;
  tasksFailed: number;
  tasksPending: number;
  tasksQueued: number;
  tasksRetried: number;
  tasksStarted: number;
  tasksSucceeded: number;
}

export interface RendererMetricsCollector {
  readonly onEvent: RendererEventSink;
  snapshot(): RendererMetricsSnapshot;
  toPrometheus(): string;
}

export type OpenTelemetryAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export interface OpenTelemetrySpan {
  addEvent?(
    name: string,
    attributes?: Record<string, OpenTelemetryAttributeValue>,
    startTime?: number,
  ): unknown;
  end?(endTime?: number): unknown;
  recordException?(exception: Error | string): unknown;
  setAttribute?(name: string, value: OpenTelemetryAttributeValue): unknown;
  setStatus?(status: { code: 0 | 1 | 2; message?: string }): unknown;
}

export interface OpenTelemetryTracer {
  startSpan(
    name: string,
    options?: {
      attributes?: Record<string, OpenTelemetryAttributeValue>;
      startTime?: number;
    },
  ): OpenTelemetrySpan;
}

const loggerLevel = (
  type: RendererEventType,
): 'debug' | 'error' | 'info' | 'warn' => {
  switch (type) {
    case 'task.failed':
      return 'error';
    case 'task.retry':
      return 'warn';
    case 'browser.connected':
    case 'browser.disconnected':
    case 'task.queued':
    case 'task.started':
      return 'debug';
    default:
      return 'info';
  }
};

const errorRecord = (error: unknown): unknown => {
  if (!(error instanceof Error)) {
    return error;
  }
  const record: Record<string, unknown> = {
    message: error.message,
    name: error.name,
  };
  if (error.stack) {
    record.stack = error.stack;
  }
  if ('code' in error) {
    record.code = error.code;
  }
  if (error.cause !== undefined) {
    record.cause = errorRecord(error.cause);
  }
  return record;
};

export const createStructuredLoggerEventSink =
  (logger: StructuredLogger): RendererEventSink =>
  event => {
    const level = loggerLevel(event.type);
    const write =
      logger[level] ??
      logger.info ??
      logger.log ??
      logger.debug ??
      logger.warn ??
      logger.error;
    write?.call(
      logger,
      {
        ...event,
        error: event.error === undefined ? undefined : errorRecord(event.error),
      },
      `pptr-helper ${event.type}`,
    );
  };

export const composeRendererEventSinks =
  (...sinks: readonly (RendererEventSink | undefined)[]): RendererEventSink =>
  async event => {
    await Promise.allSettled(
      sinks.map(sink => Promise.resolve().then(() => sink?.(event))),
    );
  };

export const createRendererMetricsCollector = (): RendererMetricsCollector => {
  const counts: RendererMetricsSnapshot = {
    browserConnected: 0,
    browserDisconnected: 0,
    browserLaunched: 0,
    tasksActive: 0,
    tasksFailed: 0,
    tasksPending: 0,
    tasksQueued: 0,
    tasksRetried: 0,
    tasksStarted: 0,
    tasksSucceeded: 0,
  };
  type TaskState = 'active' | 'pending';
  const taskStates = new Map<string, TaskState[]>();

  const addTask = (taskId: string, state: TaskState) => {
    const states = taskStates.get(taskId) ?? [];
    states.push(state);
    taskStates.set(taskId, states);
  };
  const startTask = (taskId: string): boolean => {
    const states = taskStates.get(taskId);
    const pending = states?.indexOf('pending') ?? -1;
    if (!states || pending < 0) {
      return false;
    }
    states[pending] = 'active';
    return true;
  };
  const finishTask = (taskId: string): TaskState | undefined => {
    const states = taskStates.get(taskId);
    if (!states) {
      return undefined;
    }
    let index = states.indexOf('active');
    if (index < 0) {
      index = states.indexOf('pending');
    }
    if (index < 0) {
      return undefined;
    }
    const [state] = states.splice(index, 1);
    if (states.length === 0) {
      taskStates.delete(taskId);
    }
    return state;
  };

  const onEvent: RendererEventSink = event => {
    switch (event.type) {
      case 'browser.connected':
        counts.browserConnected += 1;
        break;
      case 'browser.disconnected':
        counts.browserDisconnected += 1;
        break;
      case 'browser.launched':
        counts.browserLaunched += 1;
        break;
      case 'task.queued':
        counts.tasksQueued += 1;
        if (event.taskId) {
          addTask(event.taskId, 'pending');
          counts.tasksPending += 1;
        }
        break;
      case 'task.started':
        counts.tasksStarted += 1;
        if (event.taskId && startTask(event.taskId)) {
          counts.tasksPending -= 1;
          counts.tasksActive += 1;
        }
        break;
      case 'task.retry':
        counts.tasksRetried += 1;
        break;
      case 'task.succeeded':
        counts.tasksSucceeded += 1;
        if (event.taskId) {
          const state = finishTask(event.taskId);
          if (state === 'active') {
            counts.tasksActive -= 1;
          } else if (state === 'pending') {
            counts.tasksPending -= 1;
          }
        }
        break;
      case 'task.failed':
        counts.tasksFailed += 1;
        if (event.taskId) {
          const state = finishTask(event.taskId);
          if (state === 'active') {
            counts.tasksActive -= 1;
          } else if (state === 'pending') {
            counts.tasksPending -= 1;
          }
        }
        break;
    }
  };

  return {
    onEvent,
    snapshot: () => ({ ...counts }),
    toPrometheus: () => {
      const snapshot = { ...counts };
      return [
        '# HELP pptr_helper_tasks_total Renderer task lifecycle events.',
        '# TYPE pptr_helper_tasks_total counter',
        `pptr_helper_tasks_total{state="queued"} ${snapshot.tasksQueued}`,
        `pptr_helper_tasks_total{state="started"} ${snapshot.tasksStarted}`,
        `pptr_helper_tasks_total{state="succeeded"} ${snapshot.tasksSucceeded}`,
        `pptr_helper_tasks_total{state="failed"} ${snapshot.tasksFailed}`,
        `pptr_helper_tasks_total{state="retried"} ${snapshot.tasksRetried}`,
        '# HELP pptr_helper_tasks_active Renderer tasks currently running.',
        '# TYPE pptr_helper_tasks_active gauge',
        `pptr_helper_tasks_active ${snapshot.tasksActive}`,
        '# HELP pptr_helper_tasks_pending Renderer tasks currently waiting.',
        '# TYPE pptr_helper_tasks_pending gauge',
        `pptr_helper_tasks_pending ${snapshot.tasksPending}`,
        '# HELP pptr_helper_browser_events_total Renderer browser lifecycle events.',
        '# TYPE pptr_helper_browser_events_total counter',
        `pptr_helper_browser_events_total{state="connected"} ${snapshot.browserConnected}`,
        `pptr_helper_browser_events_total{state="disconnected"} ${snapshot.browserDisconnected}`,
        `pptr_helper_browser_events_total{state="launched"} ${snapshot.browserLaunched}`,
        '',
      ].join('\n');
    },
  };
};

export const createOpenTelemetryEventSink = (
  tracer: OpenTelemetryTracer,
): RendererEventSink => {
  const spans = new Map<string, OpenTelemetrySpan>();

  return event => {
    const taskId = event.taskId;
    if (!taskId) {
      return;
    }
    if (event.type === 'task.queued') {
      const replaced = spans.get(taskId);
      replaced?.setStatus?.({ code: 2, message: 'Task identifier reused' });
      replaced?.end?.(event.timestamp);
      spans.set(
        taskId,
        tracer.startSpan('pptr-helper.render', {
          attributes: {
            'pptr.task.id': taskId,
          },
          startTime: event.timestamp,
        }),
      );
      return;
    }

    const span = spans.get(taskId);
    if (!span) {
      return;
    }
    span.addEvent?.(
      event.type,
      event.attempt === undefined
        ? undefined
        : { 'pptr.task.attempt': event.attempt },
      event.timestamp,
    );
    if (event.attempt !== undefined) {
      span.setAttribute?.('pptr.task.attempts', event.attempt);
    }
    if (event.type === 'task.retry' && event.error !== undefined) {
      span.recordException?.(
        event.error instanceof Error ? event.error : String(event.error),
      );
      return;
    }
    if (event.type === 'task.succeeded') {
      span.setStatus?.({ code: 1 });
      span.end?.(event.timestamp);
      spans.delete(taskId);
      return;
    }
    if (event.type === 'task.failed') {
      if (event.error !== undefined) {
        span.recordException?.(
          event.error instanceof Error ? event.error : String(event.error),
        );
      }
      span.setStatus?.({
        code: 2,
        message:
          event.error instanceof Error
            ? event.error.message
            : String(event.error ?? 'Renderer task failed'),
      });
      span.end?.(event.timestamp);
      spans.delete(taskId);
    }
  };
};
