/**
 * OpenTelemetry + Pyroscope bootstrap, shared by every microservice.
 *
 * Each service preloads this BEFORE its own code so auto-instrumentation can
 * patch http/express/etc:
 *   tsx watch --import ./packages/shared-observability/src/instrumentation.ts services/<svc>/src/main.ts
 *
 * Set OTEL_SERVICE_NAME per service (chat-service, realtime-service, …) so each
 * shows up separately in Grafana. Endpoints/auth come from env (see
 * .env.observability) and default to a local collector.
 *
 * Signals: traces + metrics → OTLP; profiles → Pyroscope (separate path); logs
 * are shipped by pino (logger.ts), not here.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { RedactingSpanProcessor } from './redacting-span-processor.js';

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'im-backend';
// Unique per running container (Docker sets HOSTNAME to the container id), so
// replicas of the same service (e.g. realtime-service-1/-2) become distinct
// series instead of colliding under one label.
const SERVICE_INSTANCE_ID = process.env.HOSTNAME ?? `${SERVICE_NAME}-${process.pid}`;
const OTLP_ENDPOINT = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(/\/$/, '');
const PYROSCOPE_ENDPOINT = process.env.PYROSCOPE_SERVER_ADDRESS ?? 'http://localhost:4040';
const PYROSCOPE_AUTH_USER = process.env.PYROSCOPE_BASIC_AUTH_USER;
const PYROSCOPE_AUTH_PASSWORD = process.env.PYROSCOPE_BASIC_AUTH_PASSWORD;
// Master switch: OBSERVABILITY_ENABLED=false turns everything off (app still runs).
const OBSERVABILITY_ENABLED = process.env.OBSERVABILITY_ENABLED !== 'false';
const PROFILING_ENABLED = OBSERVABILITY_ENABLED && process.env.PROFILING_ENABLED !== 'false';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
    'service.instance.id': SERVICE_INSTANCE_ID,
  }),
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
      '@opentelemetry/instrumentation-runtime-node': { enabled: true }, // event loop lag / GC / heap
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

if (OBSERVABILITY_ENABLED) {
  sdk.start();
} else {
  // eslint-disable-next-line no-console -- bootstrap, logger not wired yet
  console.log(`[instrumentation] ${SERVICE_NAME}: OBSERVABILITY_ENABLED=false — telemetry off`);
}

// ─── Pyroscope: profiling (separate path; degrade gracefully) ─────────────────
let stopProfiling: (() => Promise<void>) | undefined;
if (PROFILING_ENABLED) {
  /* eslint-disable no-console -- bootstrap diagnostics */
  import('@pyroscope/nodejs')
    .then((mod) => {
      const p = ((mod as { default?: unknown }).default ?? mod) as {
        init: (c: unknown) => void;
        start: () => void;
        stop: () => Promise<void>;
        setLogger?: (l: unknown) => void;
      };
      p.setLogger?.(console);
      p.init({
        serverAddress: PYROSCOPE_ENDPOINT,
        appName: SERVICE_NAME,
        tags: { service_name: SERVICE_NAME },
        ...(PYROSCOPE_AUTH_USER
          ? { basicAuthUser: PYROSCOPE_AUTH_USER, basicAuthPassword: PYROSCOPE_AUTH_PASSWORD }
          : {}),
      });
      p.start();
      stopProfiling = () => p.stop();
    })
    .catch((err: unknown) => {
      console.error(`[instrumentation] ${SERVICE_NAME} profiling disabled:`, (err as Error).message);
    });
  /* eslint-enable no-console */
}

// ─── Telemetry shutdown ───────────────────────────────────────────────────────
// Exposed so a service's own shutdown can flush telemetry before exit. We don't
// register signal handlers here so as not to preempt each service's cleanup;
// the periodic exporters flush every ~10s, so at most a few seconds are lost on
// an unclean stop.
let shuttingDown = false;
export async function shutdownTelemetry(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (OBSERVABILITY_ENABLED) await sdk.shutdown();
  if (stopProfiling) await stopProfiling();
}
