const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "secret",
  "token",
  "api_key",
  "apikey",
]);

export function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForLog);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redactForLog(item),
      ]),
    );
  }
  return value;
}
