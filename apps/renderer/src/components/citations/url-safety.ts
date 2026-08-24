/**
 * Client-side defense in depth (see `@ai-browser/contracts`'s
 * `HttpUrlSchema`, which the desktop main process re-checks server-side
 * before ever calling `shell.openExternal`): only ever pass through a URL
 * that is absolute and `http`/`https`. This does not replace the main
 * process check -- it just means the renderer never even offers an
 * "Open source" control for a URL it wouldn't be safe to open.
 */
export function isSafeExternalUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** The origin (scheme + host) to display as a citation's destination, e.g. "https://example.com". */
export function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}
