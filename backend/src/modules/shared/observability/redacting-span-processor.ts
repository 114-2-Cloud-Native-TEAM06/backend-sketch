import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { containsSecret, redactSecrets } from './redact.js';

/**
 * Scrubs secrets (e.g. the JWT in `?token=`) from span attributes before export.
 *
 * Registered ahead of the exporting BatchSpanProcessor so the mutation lands
 * before the span is enqueued. Mutates the attributes object in place: the
 * Span#setAttribute API is a no-op after a span ends, but the underlying
 * `attributes` record the exporter later reads is the same reference, so
 * writing to it directly is what actually takes effect here.
 */
export class RedactingSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {
    // no-op; redaction happens at end once all attributes are present.
  }

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes as Record<string, unknown>;
    for (const key of Object.keys(attributes)) {
      const value = attributes[key];
      if (typeof value === 'string' && containsSecret(value)) {
        attributes[key] = redactSecrets(value);
      }
    }

    // Some HTTP/ws instrumentations fold the query string into the span name.
    // `name` is readonly on the ReadableSpan interface but a plain mutable field
    // on the underlying Span, so assign through a narrowed cast.
    if (containsSecret(span.name)) {
      (span as unknown as { name: string }).name = redactSecrets(span.name);
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
