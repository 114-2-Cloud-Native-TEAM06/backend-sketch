import { metrics } from '@opentelemetry/api';

/**
 * Custom IM metrics. The meter is a no-op until the OTel SDK (instrumentation.ts)
 * registers a MeterProvider; since instrumentation is preloaded via --import, by
 * the time app modules import this file the real meter is in place.
 */
const meter = metrics.getMeter('im-backend');

/** Messages successfully persisted + acked over the WebSocket. */
export const messagesSentTotal = meter.createCounter('im_messages_sent_total', {
  description: 'Total chat messages persisted and acknowledged via WebSocket',
});

/** WebSocket-path errors (failed sends, internal errors). */
export const wsErrorsTotal = meter.createCounter('im_ws_errors_total', {
  description: 'Total WebSocket message-handling errors',
});

/** Time to fan a persisted message out to the room's sockets. */
export const messageFanoutDuration = meter.createHistogram('im_message_fanout_duration', {
  description: 'Duration of fanning a message out to room sockets',
  unit: 'ms',
});

const activeConnectionsGauge = meter.createObservableGauge('im_ws_active_connections', {
  description: 'Currently open WebSocket connections',
});

/**
 * Register the active-connections gauge against a synchronous, O(1) getter.
 * The callback runs at metric-export time, so it MUST stay cheap and sync —
 * no awaits, no locks, no map iteration.
 *
 * Returns a disposer; call it when the owning server closes so callbacks don't
 * accumulate (each would retain a stale store and emit duplicate observations).
 */
export function observeActiveConnections(getCount: () => number): () => void {
  const callback = (result: { observe(value: number): void }) => result.observe(getCount());
  activeConnectionsGauge.addCallback(callback);
  return () => activeConnectionsGauge.removeCallback(callback);
}
