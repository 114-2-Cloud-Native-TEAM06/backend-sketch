import { context, trace } from '@opentelemetry/api';
import pino, { type Logger } from 'pino';

/**
 * Structured logger with trace correlation, shared by all services.
 *
 * - trace_id / span_id are injected via pino's `mixin` (reads the active OTel
 *   span context). Hook-independent, so it works under pure ESM.
 * - In normal runs logs ship to the OTLP collector / Grafana Cloud via
 *   pino-opentelemetry-transport (worker thread) AND mirror to stdout.
 * - Disabled (plain stdout, no worker) under tests or when
 *   OBSERVABILITY_ENABLED=false / OTEL_LOGS_DISABLED=true.
 */
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'im-backend';
const LEVEL = process.env.LOG_LEVEL ?? 'info';
const SHIP_LOGS =
  process.env.OBSERVABILITY_ENABLED !== 'false' &&
  process.env.NODE_ENV !== 'test' &&
  process.env.OTEL_LOGS_DISABLED !== 'true';

function traceContextMixin(): Record<string, string | number> {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const { traceId, spanId, traceFlags } = span.spanContext();
  return { trace_id: traceId, span_id: spanId, trace_flags: traceFlags };
}

let transport: ReturnType<typeof pino.transport> | undefined;

function buildLogger(): Logger {
  const base = { level: LEVEL, base: { service: SERVICE_NAME }, mixin: traceContextMixin };
  if (!SHIP_LOGS) {
    return pino(base);
  }
  transport = pino.transport({
    targets: [
      {
        target: 'pino-opentelemetry-transport',
        level: LEVEL,
        options: { loggerName: SERVICE_NAME, resourceAttributes: { 'service.name': SERVICE_NAME } },
      },
      { target: 'pino/file', level: LEVEL, options: { destination: 1 } },
    ],
  });
  return pino(base, transport);
}

export const logger = buildLogger();

/** Flush buffered logs + close the transport worker before process exit. */
export async function shutdownLogger(): Promise<void> {
  await new Promise<void>((resolve) => logger.flush(() => resolve()));
  if (transport) {
    await new Promise<void>((resolve) => {
      transport!.once('close', () => resolve());
      transport!.end();
    });
  }
}
