import { describe, expect, it } from "vitest";

import { ALLOWED_CHANNELS, AppInfoSchema, isAllowedChannel } from "../src/shared/ipc-contract";

describe("ALLOWED_CHANNELS (preload allowlist)", () => {
  it("is exactly the expected set of channels -- no accidental extra exposure", () => {
    // Phase 0 exposes exactly one read-only channel. Any future feature
    // that adds a channel must extend this list deliberately, which makes
    // this test fail until it does -- that's the point: an accidental
    // extra `ipcRenderer.invoke` call elsewhere in preload code would not
    // be allowlisted and this test pins the allowlist to a known set.
    expect([...ALLOWED_CHANNELS].sort()).toEqual(["app:get-info"]);
  });

  it("recognizes only allowlisted channel names", () => {
    expect(isAllowedChannel("app:get-info")).toBe(true);
    expect(isAllowedChannel("shell:open-external")).toBe(false);
    expect(isAllowedChannel("fs:read-file")).toBe(false);
    expect(isAllowedChannel("")).toBe(false);
  });
});

describe("AppInfoSchema", () => {
  it("accepts a well-formed app-info payload", () => {
    const result = AppInfoSchema.safeParse({
      name: "AI-Native Browser",
      version: "0.1.0",
      electronVersion: "33.0.0",
      platform: "win32",
      isPackaged: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload with an extra, unexpected field", () => {
    const result = AppInfoSchema.safeParse({
      name: "AI-Native Browser",
      version: "0.1.0",
      electronVersion: "33.0.0",
      platform: "win32",
      isPackaged: false,
      serviceToken: "should-never-be-here",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload missing a required field", () => {
    const result = AppInfoSchema.safeParse({
      name: "AI-Native Browser",
      version: "0.1.0",
    });
    expect(result.success).toBe(false);
  });
});
