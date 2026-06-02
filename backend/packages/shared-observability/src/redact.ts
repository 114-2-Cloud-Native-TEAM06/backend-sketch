/**
 * Centralised secret redaction for telemetry.
 *
 * The WebSocket handshake carries the JWT in the query string (`?token=<JWT>`),
 * so any telemetry attribute that captures a URL can leak it. Run such values
 * through redactSecrets before they reach an exporter.
 */
const TOKEN_QUERY_RE = /(^|[?&])((?:token|access_token|jwt)=)[^&#\s]+/gi;

export function redactSecrets(value: string): string {
  return value.replace(TOKEN_QUERY_RE, '$1$2REDACTED');
}

export function containsSecret(value: string): boolean {
  TOKEN_QUERY_RE.lastIndex = 0;
  return TOKEN_QUERY_RE.test(value);
}
