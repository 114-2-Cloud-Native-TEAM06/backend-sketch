/**
 * Centralised secret redaction for telemetry.
 *
 * The WebSocket handshake carries the JWT in the query string (`?token=<JWT>`),
 * so any telemetry attribute that captures a URL (span name, `http.url`,
 * `http.target`, `url.query`, `url.full`, …) can leak a 7-day-valid token.
 * Run every such value through `redactSecrets` rather than scrubbing in one
 * instrumentation hook only.
 */

// `token=<value>` in a query string / URL — keep the key, drop the value.
// The leading `(^|[?&])` also matches a bare query attribute such as
// `url.query = "token=abc&x=1"` where there is no leading `?`.
const TOKEN_QUERY_RE = /(^|[?&])((?:token|access_token|jwt)=)[^&#\s]+/gi;

export function redactSecrets(value: string): string {
  return value.replace(TOKEN_QUERY_RE, '$1$2REDACTED');
}

export function containsSecret(value: string): boolean {
  TOKEN_QUERY_RE.lastIndex = 0;
  return TOKEN_QUERY_RE.test(value);
}
