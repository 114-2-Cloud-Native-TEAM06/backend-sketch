/**
 * OpenTelemetry + Pyroscope bootstrap.
 *
 * MUST be loaded before any application module so auto-instrumentation can
 * patch express / ws / prisma. Loaded via:
 *   tsx watch --import ./src/instrumentation.ts src/index.ts
 *
 * Signals:
 *   - traces  → OTLP/HTTP → Collector → Tempo
 *   - metrics → OTLP/HTTP → Collector → Mimir
 *   - profiles→ Pyroscope SDK → Pyroscope server (separate path, NOT via OTLP)
 *   - logs are shipped by pino (see modules/shared/observability/logger.ts), not here.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { RedactingSpanProcessor } from './modules/shared/observability/redacting-span-processor.js';

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'im-backend';
const OTLP_ENDPOINT = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(/\/$/, '');
const PYROSCOPE_ENDPOINT = process.env.PYROSCOPE_SERVER_ADDRESS ?? 'http://localhost:4040';
// Master switch: OBSERVABILITY_ENABLED=false turns off traces, metrics, log
// shipping AND profiling in one flag (the app still runs, logging to stdout).
const OBSERVABILITY_ENABLED = process.env.OBSERVABILITY_ENABLED !== 'false';
const PROFILING_ENABLED = OBSERVABILITY_ENABLED && process.env.PROFILING_ENABLED !== 'false';

// ─── OpenTelemetry: traces + metrics ─────────────────────────────────────────
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
  }),
  // RedactingSpanProcessor MUST precede the exporting processor so token=... is
  // scrubbed before the span is enqueued for export.
  spanProcessors: [
    new RedactingSpanProcessor(),
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${OTLP_ENDPOINT}/v1/traces` })),
  ],
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${OTLP_ENDPOINT}/v1/metrics` }),
      exportIntervalMillis: 10_000,
    }),
  ],
  instrumentations: [
    getNodeAutoInstrumentations({
      // Node runtime metrics: event loop lag / GC / heap — the core IM health signals.
      '@opentelemetry/instrumentation-runtime-node': { enabled: true },
      // fs spans are noisy and rarely the bottleneck for this workload.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

if (OBSERVABILITY_ENABLED) {
  sdk.start();
} else {
  // eslint-disable-next-line no-console -- logger not yet wired at bootstrap
  console.log('[instrumentation] OBSERVABILITY_ENABLED=false — telemetry off');
}

// ─── Pyroscope: profiling (separate path; degrade gracefully if it fails) ─────
// Dynamic import: the native @datadog/pprof binding only loads on the Linux
// container, and a profiling failure must never take down the app.
let stopProfiling: (() => Promise<void>) | undefined;
if (PROFILING_ENABLED) {
  /* eslint-disable no-console -- bootstrap diagnostics, logger not wired yet */
  import('@pyroscope/nodejs')
    .then((mod) => {
      const Pyroscope = (mod as { default?: unknown }).default ?? mod;
      const p = Pyroscope as Record<string, unknown> & {
        init: (c: unknown) => void;
        start: () => void;
        stop: () => Promise<void>;
      };
      console.log(`[instrumentation] pyroscope module keys: ${Object.keys(p).join(',')}`);
      p.init({
        serverAddress: PYROSCOPE_ENDPOINT,
        appName: SERVICE_NAME,
        tags: { service_name: SERVICE_NAME },
      });
      p.start();
      console.log(`[instrumentation] pyroscope STARTED → ${PYROSCOPE_ENDPOINT} app=${SERVICE_NAME}`);
      stopProfiling = () => p.stop();
    })
    .catch((err: unknown) => {
      console.error('[instrumentation] profiling disabled:', (err as Error).message, (err as Error).stack);
    });
  /* eslint-enable no-console */
}

// ─── Telemetry shutdown ───────────────────────────────────────────────────────
// Flushes OTel queues + stops the profiler. The app entry (index.ts) owns the
// process lifecycle: it closes the HTTP/ws servers first, THEN calls this, THEN
// exits. Signal handling deliberately lives in index.ts, not here, so it runs
// only when the app is the real entrypoint (never during tests).
let shuttingDown = false;
export async function shutdownTelemetry(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (OBSERVABILITY_ENABLED) await sdk.shutdown();
  if (stopProfiling) await stopProfiling();
}
