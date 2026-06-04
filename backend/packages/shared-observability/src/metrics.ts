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

/**
 * Currently open WebSocket connections. A synchronous UpDownCounter rather than
 * an ObservableGauge: sync instruments export reliably here, whereas async
 * callbacks were not being collected (gauge stayed at 0). add(+1) on connect,
 * add(-1) on close — net value is the live open-connection count.
 */
export const wsActiveConnections = meter.createUpDownCounter('im_ws_active_connections', {
  description: 'Currently open WebSocket connections',
});
