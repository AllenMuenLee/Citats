import { describe, expect, it } from "vitest";

import { generateServiceToken } from "../src/main/service-token";

describe("generateServiceToken", () => {
  it("produces a sufficiently long, non-default hex string", () => {
    const token = generateServiceToken();
    // 32 random bytes hex-encoded -> 64 hex characters.
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe("changeme");
    expect(token).not.toBe("0".repeat(64));
  });

  it("produces a different value on every call (per-launch, not fixed)", () => {
    const a = generateServiceToken();
    const b = generateServiceToken();
    expect(a).not.toEqual(b);
  });

  it("has high enough entropy that repeated calls don't collide", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generateServiceToken());
    }
    expect(seen.size).toBe(1000);
  });
});
