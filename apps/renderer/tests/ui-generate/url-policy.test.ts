import { describe, expect, it } from "vitest";
import {
  assertPublicDestination,
  isPrivateAddress,
  normalizeCandidateUrl,
  readSourceOriginPolicy,
  validateCandidateUrls,
} from "../../src/server/ui-generate/source-finding/url-policy";

/**
 * P03-F01 step 4. The source-finding model proposes strings; nothing it
 * says decides whether one may be opened. These are the checks that do.
 */
describe("candidate URL normalization", () => {
  it("accepts a plain public https URL and normalizes it", () => {
    const decision = normalizeCandidateUrl("HTTPS://Example.COM:443/path?b=2&a=1");
    expect(decision).toMatchObject({ ok: true, origin: "https://example.com" });
    if (decision.ok) {
      // Query order is preserved deliberately: reordering it would change
      // which page is captured.
      expect(decision.url).toBe("https://example.com/path?b=2&a=1");
    }
  });

  it.each([
    ["ftp://example.com/x", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["https://user:pass@example.com/", "credentials"],
    ["https://example.com/#section", "fragment"],
    ["https://example.com:8080/", "port"],
    ["not a url", "malformed"],
  ])("rejects %s", (url, reason) => {
    expect(normalizeCandidateUrl(url)).toEqual({ ok: false, reason });
  });

  it.each([
    "http://localhost/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://0.0.0.0/",
    "http://service.internal/",
    "http://printer.local/",
  ])("rejects the non-public destination %s", (url) => {
    expect(normalizeCandidateUrl(url)).toEqual({ ok: false, reason: "private_destination" });
  });

  it("classifies private addresses including IPv4-mapped IPv6 forms", () => {
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("applies the configured origin policy", () => {
    const blocked = normalizeCandidateUrl("https://blocked.example/", { allowedOrigins: [], blockedOrigins: ["https://blocked.example"] });
    expect(blocked).toEqual({ ok: false, reason: "blocked_origin" });

    const policy = { allowedOrigins: ["https://allowed.example"], blockedOrigins: [] };
    expect(normalizeCandidateUrl("https://allowed.example/x", policy).ok).toBe(true);
    expect(normalizeCandidateUrl("https://other.example/x", policy)).toEqual({ ok: false, reason: "not_allowlisted" });
  });

  it("reads an origin policy from the environment", () => {
    const policy = readSourceOriginPolicy({
      UI_SOURCE_ORIGIN_ALLOWLIST: "example.com, https://docs.example.com",
      UI_SOURCE_ORIGIN_BLOCKLIST: "bad.example",
    });
    expect(policy.allowedOrigins).toEqual(["https://example.com", "https://docs.example.com"]);
    expect(policy.blockedOrigins).toEqual(["https://bad.example"]);
  });
});

describe("DNS destination checks", () => {
  it("rejects a name that resolves to any non-public address", async () => {
    const rebinding = async () => ["93.184.216.34", "127.0.0.1"];
    expect(await assertPublicDestination("https://rebind.example/", rebinding)).toEqual({ ok: false, reason: "private_destination" });
  });

  it("accepts a name that resolves only to public addresses", async () => {
    const decision = await assertPublicDestination("https://public.example/", async () => ["93.184.216.34"]);
    expect(decision.ok).toBe(true);
  });

  it("rejects an unresolvable name rather than assuming it is public", async () => {
    expect(await assertPublicDestination("https://missing.example/", async () => [])).toEqual({ ok: false, reason: "unresolvable" });
    expect(
      await assertPublicDestination("https://broken.example/", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toEqual({ ok: false, reason: "unresolvable" });
  });
});

describe("candidate list validation", () => {
  const resolve = async () => ["93.184.216.34"];

  it("preserves order, drops duplicates, and bounds the count", async () => {
    const result = await validateCandidateUrls(
      [
        { url: "https://a.example/1", reason: "first" },
        { url: "https://b.example/2", reason: "second" },
        { url: "https://a.example/1", reason: "again" },
        { url: "http://127.0.0.1/", reason: "loopback" },
        { url: "https://c.example/3", reason: "third" },
      ],
      { maxAccepted: 2, resolve },
    );
    expect(result.accepted.map((candidate) => candidate.url)).toEqual(["https://a.example/1", "https://b.example/2"]);
  });

  it("records why each candidate was rejected", async () => {
    const result = await validateCandidateUrls(
      [
        { url: "http://10.0.0.1/", reason: "private" },
        { url: "ftp://x.example/", reason: "scheme" },
        { url: "https://ok.example/", reason: "fine" },
        { url: "https://ok.example/", reason: "dupe" },
      ],
      { maxAccepted: 5, resolve },
    );
    expect(result.rejected).toEqual(["private_destination", "scheme", "duplicate"]);
    expect(result.accepted).toHaveLength(1);
  });
});
