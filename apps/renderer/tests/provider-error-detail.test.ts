import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  mapHttpStatus,
  rateLimitResetLogFields,
  readProviderErrorDetail,
  retryDelayFromMessage,
} from "../src/server/ai/streaming";

describe("readProviderErrorDetail", () => {
  it("keeps only the four diagnosable fields of a provider error body", () => {
    const detail = readProviderErrorDetail(400, JSON.stringify({
      error: {
        message: "invalid JSON schema for tool browser.navigate_and_extract",
        type: "invalid_request_error",
        code: "schema_invalid",
        param: "tool browser.navigate_and_extract",
      },
    }));

    expect(detail).toEqual({
      status: 400,
      type: "invalid_request_error",
      code: "schema_invalid",
      message: "invalid JSON schema for tool browser.navigate_and_extract",
    });
  });

  /**
   * `failed_generation` carries the model's own rejected output, which may
   * quote untrusted page content. The detail is logged, so it must never
   * survive extraction.
   */
  it("drops failed_generation rather than carrying model output into the log", () => {
    const detail = readProviderErrorDetail(400, JSON.stringify({
      error: {
        message: "Failed to parse tool call arguments as JSON",
        code: "tool_use_failed",
        failed_generation: "{\"name\": \"browser.navigate_and_extract\", \"arguments\": \"<untrusted page text>\"",
      },
    }));

    expect(detail).not.toHaveProperty("failed_generation");
    expect(JSON.stringify(detail)).not.toContain("untrusted page text");
  });

  it("truncates an oversized provider message", () => {
    const detail = readProviderErrorDetail(400, JSON.stringify({ error: { message: "x".repeat(5_000) } }));
    expect(detail.message).toHaveLength(500);
  });

  it("degrades to the status alone for a non-JSON or empty body", () => {
    expect(readProviderErrorDetail(503, "<html>gateway</html>")).toEqual({ status: 503 });
    expect(readProviderErrorDetail(500, "")).toEqual({ status: 500 });
  });
});

describe("mapHttpStatus", () => {
  it("reports a rejected request as such rather than as a safety refusal", () => {
    expect(mapHttpStatus(400).code).toBe("AI_REQUEST_REJECTED");
    expect(mapHttpStatus(422).code).toBe("AI_REQUEST_REJECTED");
    expect(mapHttpStatus(404).code).toBe("AI_REQUEST_REJECTED");
  });

  it("separates a transient unparseable tool call from a rejected request", () => {
    expect(mapHttpStatus(400, { status: 400, code: "tool_use_failed" }).code).toBe("AI_MALFORMED_RESPONSE");
  });

  it("keeps the credential and rate-limit mappings", () => {
    expect(mapHttpStatus(401).code).toBe("AI_AUTHENTICATION_FAILED");
    expect(mapHttpStatus(403).code).toBe("AI_AUTHENTICATION_FAILED");
    expect(mapHttpStatus(429).code).toBe("AI_RATE_LIMITED");
    expect(mapHttpStatus(500).code).toBe("AI_PROVIDER_UNAVAILABLE");
  });

  it("reports the provider's own message verbatim, and nothing else from the body", () => {
    const error = mapHttpStatus(400, { status: 400, message: "invalid JSON schema for tool browser.explore_website" });
    expect(error.message).toBe("invalid JSON schema for tool browser.explore_website");
    // `readProviderErrorDetail` is what keeps the rest of the body out; only
    // the fields it extracted are reachable from here.
    expect(readProviderErrorDetail(400, JSON.stringify({
      error: { message: "no", failed_generation: "<untrusted page content>" },
    }))).not.toHaveProperty("failed_generation");
  });

  it("falls back to the generic text when the provider stated no reason", () => {
    expect(mapHttpStatus(400).message).toBe("The AI service rejected this request as invalid.");
    expect(mapHttpStatus(400, { status: 400, message: "   " }).message)
      .toBe("The AI service rejected this request as invalid.");
  });
});

/**
 * A live Gemini 429 carries no `Retry-After` and no `x-ratelimit-*` header --
 * the stated wait exists only in the body, in two places, and missing both
 * collapsed the backoff to its 100ms floor and spent the remaining attempts
 * against an already-exhausted quota.
 */
describe("rate-limit delay recovery", () => {
  const geminiRateLimitBody = JSON.stringify({
    error: {
      code: 429,
      message: "You exceeded your current quota, please check your plan and billing details. "
        + "* Quota exceeded for metric: generate_content_free_tier_requests, limit: 15, "
        + "model: gemini-3.5-flash-lite. Please retry in 3.215563756s.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.Help", links: [{ url: "https://ai.google.dev/" }] },
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generate_content_free_tier_requests" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3.215563756s" },
      ],
    },
  });

  it("recovers Gemini's RetryInfo from error.details", () => {
    expect(readProviderErrorDetail(429, geminiRateLimitBody).retryAfterMs).toBe(3_216);
  });

  it("keeps the rest of error.details out of the logged detail", () => {
    const detail = readProviderErrorDetail(429, geminiRateLimitBody);
    expect(detail).not.toHaveProperty("details");
    expect(JSON.stringify(detail)).not.toContain("QuotaFailure");
  });

  it("omits retryAfterMs when the body states no delay", () => {
    expect(readProviderErrorDetail(429, JSON.stringify({ error: { message: "slow down" } })))
      .not.toHaveProperty("retryAfterMs");
    expect(readProviderErrorDetail(429, JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "soon" }] } })))
      .not.toHaveProperty("retryAfterMs");
  });

  it("reads the stated delay from either provider's wording", () => {
    expect(retryDelayFromMessage("Please retry in 3.215563756s.")).toBe(3_216);
    expect(retryDelayFromMessage("Rate limit reached. Please try again in 812ms")).toBe(812);
    expect(retryDelayFromMessage("Rate limit reached. Please try again in 1m")).toBe(60_000);
    expect(retryDelayFromMessage("no delay stated")).toBe(0);
    expect(retryDelayFromMessage(undefined)).toBe(0);
  });

  it("formats a provider-supplied reset as seconds and an absolute time for logs", () => {
    expect(rateLimitResetLogFields(3_216, Date.parse("2026-09-01T12:00:00.000Z"))).toEqual({
      retryAfterSeconds: 4,
      retryAt: "2026-09-01T12:00:03.216Z",
      resetHint: "provider-supplied",
    });
  });

  it("states explicitly when the provider supplied no reset countdown", () => {
    expect(rateLimitResetLogFields(0)).toEqual({
      retryAfterSeconds: null,
      retryAt: null,
      resetHint: "not-provided",
    });
  });
});
