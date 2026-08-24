import { describe, expect, it } from "vitest";

import { ShellOpenExternalResultSchema, validateExternalUrl } from "../src/shared/ipc-contract";

describe("validateExternalUrl", () => {
  it("accepts an http URL", () => {
    expect(validateExternalUrl("http://example.com/page")).toEqual({
      ok: true,
      url: "http://example.com/page",
    });
  });

  it("accepts an https URL", () => {
    expect(validateExternalUrl("https://example.com/article?x=1#frag")).toEqual({
      ok: true,
      url: "https://example.com/article?x=1#frag",
    });
  });

  it("rejects a javascript: URL", () => {
    expect(validateExternalUrl("javascript:alert(1)")).toEqual({ ok: false, reason: "invalid_url" });
  });

  it("rejects a file: URL", () => {
    expect(validateExternalUrl("file:///etc/passwd")).toEqual({ ok: false, reason: "invalid_url" });
  });

  it("rejects a data: URL", () => {
    expect(validateExternalUrl("data:text/html,<script>alert(1)</script>")).toEqual({
      ok: false,
      reason: "invalid_url",
    });
  });

  it("rejects a malformed string", () => {
    expect(validateExternalUrl("not a url")).toEqual({ ok: false, reason: "invalid_url" });
    expect(validateExternalUrl("")).toEqual({ ok: false, reason: "invalid_url" });
  });

  it("rejects non-string input without throwing", () => {
    expect(() => validateExternalUrl(undefined)).not.toThrow();
    expect(validateExternalUrl(undefined)).toEqual({ ok: false, reason: "invalid_url" });
    expect(validateExternalUrl(null)).toEqual({ ok: false, reason: "invalid_url" });
    expect(validateExternalUrl(42)).toEqual({ ok: false, reason: "invalid_url" });
    expect(validateExternalUrl({ url: "https://example.com" })).toEqual({ ok: false, reason: "invalid_url" });
  });

  it("rejects a protocol-relative or bare host string", () => {
    expect(validateExternalUrl("//example.com")).toEqual({ ok: false, reason: "invalid_url" });
    expect(validateExternalUrl("example.com")).toEqual({ ok: false, reason: "invalid_url" });
  });
});

describe("ShellOpenExternalResultSchema", () => {
  it("accepts a success result", () => {
    expect(ShellOpenExternalResultSchema.safeParse({ ok: true }).success).toBe(true);
  });

  it("accepts a failure result", () => {
    expect(ShellOpenExternalResultSchema.safeParse({ ok: false, reason: "invalid_url" }).success).toBe(true);
    expect(ShellOpenExternalResultSchema.safeParse({ ok: false, reason: "open_failed" }).success).toBe(true);
  });

  it("rejects a success result carrying an extra field (strict)", () => {
    expect(ShellOpenExternalResultSchema.safeParse({ ok: true, url: "https://example.com" }).success).toBe(false);
  });

  it("rejects an unknown failure reason", () => {
    expect(ShellOpenExternalResultSchema.safeParse({ ok: false, reason: "blocked" }).success).toBe(false);
  });
});
