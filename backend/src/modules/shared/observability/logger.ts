import { context, trace } from '@opentelemetry/api';
import pino, { type Logger } from 'pino';

/**
 * Structured logger with trace correlation.
 *
 * - trace_id / span_id are injected via pino's `mixin` (reads the active OTel
 *   span context). This is hook-independent, so it works under pure ESM where
 *   module-patching instrumentation can silently fail to attach.
 * - In normal runs, logs are shipped to the OTLP collector via
 *   `pino-opentelemetry-transport` (a worker thread, separate from the OTel
 *   SDK) and ALSO mirrored to stdout for `docker logs`.
 * - Under tests we skip the transport worker entirely: a plain stdout logger,
 *   no worker thread, no network connection to a collector that isn't running.
 */
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'im-backend';
const LEVEL = process.env.LOG_LEVEL ?? 'info';
const SHIP_LOGS = process.env.NODE_ENV !== 'test' && process.env.OTEL_LOGS_DISABLED !== 'true';

function traceContextMixin(): Record<string, string | number> {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const { traceId, spanId, traceFlags } = span.spanContext();
  return { trace_id: traceId, span_id: spanId, trace_flags: traceFlags };
}

// Held so shutdownLogger() can flush + close the worker thread on graceful exit.
let transport: ReturnType<typeof pino.transport> | undefined;

function buildLogger(): Logger {
  const base = { level: LEVEL, mixin: traceContextMixin };
  if (!SHIP_LOGS) {
    return pino(base);
  }
  transport = pino.transport({
    targets: [
      {
        target: 'pino-opentelemetry-transport',
        level: LEVEL,
        options: {
          loggerName: SERVICE_NAME,
          resourceAttributes: { 'service.name': SERVICE_NAME },
        },
      },
      // Keep human-readable logs on stdout for `docker logs` / Codespaces.
      { target: 'pino/file', level: LEVEL, options: { destination: 1 } },
    ],
  });
  return pino(base, transport);
}

export const logger = buildLogger();

/**
 * Flush buffered logs and close the transport worker. Awaiting this before
 * process.exit() is what stops the final OTLP log batch from being dropped.
 */
export async function shutdownLogger(): Promise<void> {
  await new Promise<void>((resolve) => logger.flush(() => resolve()));
  if (transport) {
    await new Promise<void>((resolve) => {
      transport!.once('close', () => resolve());
      transport!.end();
    });
  }
}
