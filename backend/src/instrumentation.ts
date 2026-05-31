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
import { register } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
// @prisma/instrumentation v5 is CommonJS; under native ESM the named export
// isn't statically detectable, so default-import the module and destructure.
import prismaInstrumentationPkg from '@prisma/instrumentation';
import { RedactingSpanProcessor } from './modules/shared/observability/redacting-span-processor.js';

const { PrismaInstrumentation } = prismaInstrumentationPkg;

// Enable import-in-the-middle so instrumentations that patch ESM-imported
// packages (notably @prisma/client) actually attach under pure ESM. Without
// this, HTTP/Express still work (require-in-the-middle on core/CJS) but Prisma
// query spans never appear. Must run before any instrumented module loads —
// i.e. before index.ts imports the app, which this file (preloaded via
// --import) does.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'im-backend';
const OTLP_ENDPOINT = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(/\/$/, '');
const PYROSCOPE_ENDPOINT = process.env.PYROSCOPE_SERVER_ADDRESS ?? 'http://localhost:4040';
const PROFILING_ENABLED = process.env.PROFILING_ENABLED !== 'false';

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
    new PrismaInstrumentation(),
  ],
});

sdk.start();

// ─── Pyroscope: profiling (separate path; degrade gracefully if it fails) ─────
// Dynamic import: the native @datadog/pprof binding only loads on the Linux
// container, and a profiling failure must never take down the app.
let stopProfiling: (() => Promise<void>) | undefined;
if (PROFILING_ENABLED) {
  import('@pyroscope/nodejs')
    .then(({ default: Pyroscope }) => {
      Pyroscope.init({
        serverAddress: PYROSCOPE_ENDPOINT,
        appName: SERVICE_NAME,
        tags: { service_name: SERVICE_NAME },
      });
      Pyroscope.start();
      stopProfiling = () => Pyroscope.stop();
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console -- logger not yet wired at bootstrap
      console.warn('[instrumentation] profiling disabled:', (err as Error).message);
    });
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
  await sdk.shutdown();
  if (stopProfiling) await stopProfiling();
}
