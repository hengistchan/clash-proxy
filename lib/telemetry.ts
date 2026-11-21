import { randomUUID } from 'node:crypto';

type Operation = 'compile.stash' | 'compile.shadowrocket' | 'compile.mihomo' | 'source.download';
type Metric = { count: number; failed: number; totalMs: number; maxMs: number };
const processState = globalThis as typeof globalThis & { __forgeTelemetry?: { operations: Map<Operation, Metric>; startedAt: string } };
const { operations, startedAt } = processState.__forgeTelemetry ??= { operations: new Map<Operation, Metric>(), startedAt: new Date().toISOString() };

export function recordOperation(operation: Operation, milliseconds: number, success: boolean) {
  const metric = operations.get(operation) ?? { count: 0, failed: 0, totalMs: 0, maxMs: 0 };
  metric.count++;
  metric.failed += Number(!success);
  metric.totalMs += Math.max(0, milliseconds);
  metric.maxMs = Math.max(metric.maxMs, milliseconds);
  operations.set(operation, metric);
}

export function operationMetrics() {
  return { startedAt, operations: Object.fromEntries([...operations].map(([key, value]) => [key, {
    count: value.count, failed: value.failed, averageMs: Math.round(value.totalMs / value.count), maxMs: Math.round(value.maxMs)
  }])) };
}

/** Never log exception messages, stacks, request URLs, headers or resource names. */
export function reportServiceFailure(error: unknown) {
  const requestId = randomUUID();
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const category = /^SQLITE_/.test(code) ? 'database' : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'timeout' : 'unexpected';
  console.error(JSON.stringify({ event: 'service.request.failed', requestId, category }));
  return requestId;
}
