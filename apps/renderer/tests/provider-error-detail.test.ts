import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { mapHttpStatus, readProviderErrorDetail } from "../src/server/ai/streaming";

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

  it("never carries the provider message into the user-facing error", () => {
    const error = mapHttpStatus(400, { status: 400, message: "invalid JSON schema for tool browser.explore_website" });
    expect(error.message).toBe("The AI service rejected this request as invalid.");
  });
});
