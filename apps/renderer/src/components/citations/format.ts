/** Formats an ISO-8601 retrieval timestamp for display; falls back to the raw string if it doesn't parse. */
export function formatRetrievedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
