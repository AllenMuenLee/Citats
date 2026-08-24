import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readBrowserServiceConfig } from "../src/server/browser-service/config";

describe("readBrowserServiceConfig", () => {
  it("returns the base URL and token when both are present", () => {
    expect(
      readBrowserServiceConfig({
        BROWSER_SERVICE_URL: "http://127.0.0.1:8000",
        BROWSER_SERVICE_TOKEN: "launch-secret",
      }),
    ).toEqual({ baseUrl: "http://127.0.0.1:8000", serviceToken: "launch-secret" });
  });

  it("returns null when the URL is missing", () => {
    expect(readBrowserServiceConfig({ BROWSER_SERVICE_TOKEN: "launch-secret" })).toBeNull();
  });

  it("returns null when the token is missing", () => {
    expect(readBrowserServiceConfig({ BROWSER_SERVICE_URL: "http://127.0.0.1:8000" })).toBeNull();
  });

  it("returns null when both are missing", () => {
    expect(readBrowserServiceConfig({})).toBeNull();
  });

  it("returns null for blank/whitespace-only values", () => {
    expect(
      readBrowserServiceConfig({ BROWSER_SERVICE_URL: "   ", BROWSER_SERVICE_TOKEN: "launch-secret" }),
    ).toBeNull();
  });
});
