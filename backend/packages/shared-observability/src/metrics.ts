import { metrics } from '@opentelemetry/api';

/**
 * Custom IM metrics. The meter is a no-op until the OTel SDK
 * (instrumentation.ts) registers a MeterProvider; since instrumentation is
 * preloaded via --import, by the time service code imports this the real meter
 * is in place. The service name comes from OTEL_SERVICE_NAME, so each
 * microservice's metrics are labelled separately in Grafana.
 */
const meter = metrics.getMeter('im-backend');

/**
 * Prisma DB query duration — fed from PrismaClient's `query` event in
 * shared-db/prisma.ts. Version-independent DB visibility (the Prisma OTel
 * auto-instrumentation is incompatible with OTel SDK 2.x). No labels: raw SQL
 * is unbounded and would explode cardinality.
 */
export const dbQueryDuration = meter.createHistogram('im_db_query_duration_ms', {
  description: 'Prisma database query duration',
  unit: 'ms',
});

/** Chat messages successfully persisted + acked over WebSocket (realtime-service). */
export const messagesSentTotal = meter.createCounter('im_messages_sent_total', {
  description: 'Total chat messages acknowledged via WebSocket',
});

/** WebSocket-path errors. */
export const wsErrorsTotal = meter.createCounter('im_ws_errors_total', {
  description: 'Total WebSocket message-handling errors',
});

/** Time to fan a persisted message out to a room's sockets. */
export const messageFanoutDuration = meter.createHistogram('im_message_fanout_duration_ms', {
  description: 'Duration of fanning a message out to room sockets',
  unit: 'ms',
});

const activeConnectionsGauge = meter.createObservableGauge('im_ws_active_connections', {
  description: 'Currently open WebSocket connections',
});

/**
 * Register the active-connections gauge against a synchronous, O(1) getter.
 * Returns a disposer; call it on server close so callbacks don't accumulate.
 * The callback runs at export time, so it MUST stay cheap and sync.
 */
export function observeActiveConnections(getCount: () => number): () => void {
  const callback = (result: { observe(value: number): void }) => result.observe(getCount());
  activeConnectionsGauge.addCallback(callback);
  return () => activeConnectionsGauge.removeCallback(callback);
}
