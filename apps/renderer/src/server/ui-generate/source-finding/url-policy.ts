import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Trusted URL validation for source finding (P03-F01 step 4).
 *
 * **The model never decides URL safety.** It proposes strings; everything
 * that decides whether one of them may be opened lives here, in code, and is
 * re-applied to every redirect hop at capture time (see
 * `capture/playwright-capture.ts`). A candidate has to survive scheme,
 * credential, fragment, length, port, origin-policy, normalization,
 * de-duplication, and DNS/IP checks before the browser is asked to navigate
 * to it.
 */

export const UI_SOURCE_URL_MAX_LENGTH = 2_048;
export const UI_SOURCE_HOST_MAX_LENGTH = 253;

export type UrlRejectionReason =
  | "malformed"
  | "scheme"
  | "credentials"
  | "fragment"
  | "too_long"
  | "port"
  | "host"
  | "blocked_origin"
  | "irrelevant_source"
  | "not_allowlisted"
  | "duplicate"
  | "private_destination"
  | "unresolvable";

export type UrlDecision =
  | { readonly ok: true; readonly url: string; readonly origin: string }
  | { readonly ok: false; readonly reason: UrlRejectionReason };

/**
 * Origin policy. `allowedOrigins` empty means "any public origin"; a
 * non-empty list makes the policy a strict allowlist, which is what a
 * locked-down deployment sets.
 */
export interface SourceOriginPolicy {
  readonly allowedOrigins: readonly string[];
  readonly blockedOrigins: readonly string[];
}

export const DEFAULT_SOURCE_ORIGIN_POLICY: SourceOriginPolicy = Object.freeze({
  allowedOrigins: [],
  blockedOrigins: [],
});

/**
 * Only the two ports a normal public website is served on. An arbitrary
 * port is the cheapest way to reach a service that happens to be listening
 * on a host that otherwise resolves publicly, so it is refused outright
 * rather than range-checked.
 */
const ALLOWED_PORTS = new Set(["", "80", "443"]);

const UI_RESOURCE_HOSTS = new Set(["v0.dev", "ui.shadcn.com"]);

/**
 * Search-engine redirect/click-tracking wrappers. A grounded model routinely
 * cites one of these instead of the page it actually found -- Gemini's
 * `groundingChunks[].web.uri` is always a `vertexaisearch.cloud.google.com`
 * redirect token, never the destination. The token is opaque, short-lived,
 * and resolves to whatever third party the search engine indexed (often a
 * bot-walled page), so it is never "rendered evidence" and is refused here
 * rather than followed.
 */
const REDIRECTOR_HOSTS = new Set([
  "vertexaisearch.cloud.google.com",
  "r.jina.ai",
]);

/** `https://www.google.com/url?q=...`, `https://news.google.com/rss/articles/...` and friends: a wrapper, not a page. */
function isSearchRedirector(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (REDIRECTOR_HOSTS.has(host)) return true;
  if ((host === "www.google.com" || host === "google.com") && url.pathname === "/url") return true;
  if (host === "news.google.com") return true;
  if ((host === "www.bing.com" || host === "bing.com") && url.pathname === "/ck/a") return true;
  return false;
}

function ipv4Parts(value: string): readonly number[] | null {
  if (isIP(value) !== 4) return null;
  return value.split(".").map((part) => Number.parseInt(part, 10));
}

/**
 * Every IPv4 range that is not a public destination: unspecified, loopback,
 * RFC1918, carrier-grade NAT, link-local (including the 169.254.169.254
 * cloud metadata endpoint), IETF protocol assignments, documentation,
 * benchmarking, multicast, and reserved.
 */
function isPrivateIpv4(value: string): boolean {
  const parts = ipv4Parts(value);
  if (!parts) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(value: string): boolean {
  if (isIP(value) !== 6) return false;
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::" || normalized === "::1") return true;
  // IPv4-mapped and IPv4-compatible forms delegate to the IPv4 rules, so
  // `::ffff:169.254.169.254` cannot slip past as "an IPv6 address".
  const mapped = /^::(?:ffff:(?:0{1,4}:)?)?(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  const head = normalized.split(":")[0] ?? "";
  if (/^f[cd][0-9a-f]{2}$/.test(head)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]$/.test(head)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}$/.test(head)) return true; // ff00::/8 multicast
  return false;
}

export function isPrivateAddress(value: string): boolean {
  return isPrivateIpv4(value) || isPrivateIpv6(value);
}

/**
 * Host names that must never resolve to a destination regardless of what
 * DNS says, because a hostile or misconfigured resolver is exactly the
 * threat the DNS check below is guarding against.
 */
function isBlockedHostname(host: string): boolean {
  const lowered = host.toLowerCase().replace(/\.$/, "");
  if (lowered === "localhost" || lowered.endsWith(".localhost")) return true;
  if (lowered.endsWith(".local") || lowered.endsWith(".internal") || lowered.endsWith(".home.arpa")) return true;
  if (lowered === "metadata" || lowered === "metadata.google.internal") return true;
  return false;
}

/**
 * Scheme/credential/fragment/length/port/host/origin checks plus
 * normalization. Pure and synchronous -- the DNS half is
 * `assertPublicDestination`, which is async and is applied both here (via
 * `validateCandidateUrls`) and again on every redirect hop.
 */
export function normalizeCandidateUrl(raw: string, policy: SourceOriginPolicy = DEFAULT_SOURCE_ORIGIN_POLICY): UrlDecision {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > UI_SOURCE_URL_MAX_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.hash) return { ok: false, reason: "fragment" };
  if (!ALLOWED_PORTS.has(url.port)) return { ok: false, reason: "port" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host.length > UI_SOURCE_HOST_MAX_LENGTH) return { ok: false, reason: "host" };
  const loweredHost = host.toLowerCase().replace(/\.$/, "");
  if ([...UI_RESOURCE_HOSTS].some((blocked) => loweredHost === blocked || loweredHost.endsWith(`.${blocked}`))) {
    return { ok: false, reason: "irrelevant_source" };
  }
  if (isSearchRedirector(url)) return { ok: false, reason: "irrelevant_source" };
  if (isBlockedHostname(host)) return { ok: false, reason: "private_destination" };
  if (isIP(host) !== 0 && isPrivateAddress(host)) return { ok: false, reason: "private_destination" };

  // Normalization: lowercase host, drop the default port, drop the fragment
  // (already refused above), and collapse an empty path to "/". Query order
  // is deliberately preserved -- a search URL's parameter order can be
  // meaningful, and reordering it would change what is captured.
  url.hostname = url.hostname.toLowerCase();
  url.port = "";
  url.hash = "";
  if (url.pathname === "") url.pathname = "/";
  const origin = url.origin.toLowerCase();
  if (policy.blockedOrigins.some((blocked) => blocked.toLowerCase() === origin)) {
    return { ok: false, reason: "blocked_origin" };
  }
  if (policy.allowedOrigins.length > 0 && !policy.allowedOrigins.some((allowed) => allowed.toLowerCase() === origin)) {
    return { ok: false, reason: "not_allowlisted" };
  }
  if (url.toString().length > UI_SOURCE_URL_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, url: url.toString(), origin };
}

export type AddressLookup = (hostname: string) => Promise<readonly string[]>;

const defaultLookup: AddressLookup = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

/**
 * Resolves a host and refuses it if *any* address it resolves to is not a
 * public destination. "Any" rather than "all" is deliberate: a name that
 * resolves to one public and one loopback address is a DNS-rebinding
 * primitive, not a usable source.
 */
export async function assertPublicDestination(
  urlString: string,
  resolve: AddressLookup = defaultLookup,
  signal?: AbortSignal,
): Promise<UrlDecision> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    return isPrivateAddress(host)
      ? { ok: false, reason: "private_destination" }
      : { ok: true, url: url.toString(), origin: url.origin.toLowerCase() };
  }
  let addresses: readonly string[];
  try {
    addresses = await abortable(resolve(host), signal);
  } catch {
    if (signal?.aborted) throw signal.reason;
    return { ok: false, reason: "unresolvable" };
  }
  if (addresses.length === 0) return { ok: false, reason: "unresolvable" };
  if (addresses.some((address) => isPrivateAddress(address))) {
    return { ok: false, reason: "private_destination" };
  }
  return { ok: true, url: url.toString(), origin: url.origin.toLowerCase() };
}

export interface ValidatedCandidate {
  readonly url: string;
  readonly origin: string;
  readonly reason: string;
}

export interface CandidateValidationResult {
  readonly accepted: readonly ValidatedCandidate[];
  /** Rejection reasons in candidate order, for safe logging. */
  readonly rejected: readonly UrlRejectionReason[];
}

/**
 * Validates the model's candidate list end to end, preserving its order and
 * dropping duplicates by normalized URL. Order matters downstream: the
 * capture loop walks this list in exactly this sequence.
 */
export async function validateCandidateUrls(
  candidates: readonly { readonly url: string; readonly reason: string }[],
  options: { policy?: SourceOriginPolicy; maxAccepted: number; resolve?: AddressLookup; signal?: AbortSignal } ,
): Promise<CandidateValidationResult> {
  const policy = options.policy ?? DEFAULT_SOURCE_ORIGIN_POLICY;
  const accepted: ValidatedCandidate[] = [];
  const rejected: UrlRejectionReason[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    options.signal?.throwIfAborted();
    if (accepted.length >= options.maxAccepted) break;
    const normalized = normalizeCandidateUrl(candidate.url, policy);
    if (!normalized.ok) {
      rejected.push(normalized.reason);
      continue;
    }
    if (seen.has(normalized.url)) {
      rejected.push("duplicate");
      continue;
    }
    seen.add(normalized.url);
    const resolved = await assertPublicDestination(normalized.url, options.resolve, options.signal);
    if (!resolved.ok) {
      rejected.push(resolved.reason);
      continue;
    }
    accepted.push({ url: normalized.url, origin: normalized.origin, reason: candidate.reason });
  }
  return { accepted, rejected };
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Reads the deployment's origin policy. Unset means "any public origin". */
export function readSourceOriginPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SourceOriginPolicy {
  const parse = (value: string | undefined): readonly string[] =>
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .flatMap((entry) => {
        const normalized = normalizeCandidateUrl(entry.includes("://") ? entry : `https://${entry}`);
        return normalized.ok ? [normalized.origin] : [];
      });
  return {
    allowedOrigins: parse(environment.UI_SOURCE_ORIGIN_ALLOWLIST),
    blockedOrigins: parse(environment.UI_SOURCE_ORIGIN_BLOCKLIST),
  };
}
