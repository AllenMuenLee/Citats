import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COLOR_TOKENS, RADIUS_TOKENS, SPACING_TOKENS } from "../src/tokens.js";

// Hardcoded from docs/desktop-architecture-and-ui-specification.md's
// "Semantic color tokens" table -- this is the independent expectation the
// exported token set (and tokens.css) are checked against, so a future
// edit that silently drops or renames a token fails this test.
const SPEC_TOKEN_NAMES = [
  "--color-bg-canvas",
  "--color-bg-surface",
  "--color-bg-elevated",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-border",
  "--color-accent",
  "--color-accent-hover",
  "--color-success",
  "--color-warning",
  "--color-danger",
  "--color-focus",
];

const SPEC_SPACING_PX = [4, 8, 12, 16, 24, 32];
const SPEC_RADIUS_PX = [6, 10, 14];

const tokensCssPath = fileURLToPath(new URL("../src/tokens.css", import.meta.url));
const tokensCss = readFileSync(tokensCssPath, "utf-8");

describe("COLOR_TOKENS", () => {
  it("contains exactly the spec's semantic color token names", () => {
    const exportedNames = COLOR_TOKENS.map((t) => t.name).sort();
    expect(exportedNames).toEqual([...SPEC_TOKEN_NAMES].sort());
  });

  it("gives every token a distinct, non-empty light and dark value", () => {
    for (const token of COLOR_TOKENS) {
      expect(token.light).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(token.dark).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(token.light).not.toEqual(token.dark);
      expect(token.purpose.length).toBeGreaterThan(0);
    }
  });

  it("declares every token's light and dark value in tokens.css", () => {
    // :root carries the light baseline; the dark declarations are repeated
    // in both the prefers-color-scheme block and the explicit
    // [data-theme="dark"] override (see tokens.css comment for why).
    const darkBlockCount = (tokensCss.match(/\[data-theme="dark"\]/g) ?? []).length;
    expect(darkBlockCount).toBeGreaterThanOrEqual(1);

    for (const token of COLOR_TOKENS) {
      const lightDecl = `${token.name}: ${token.light.toLowerCase()};`;
      const darkDecl = `${token.name}: ${token.dark.toLowerCase()};`;
      expect(tokensCss.toLowerCase()).toContain(lightDecl);
      expect(tokensCss.toLowerCase()).toContain(darkDecl);
    }
  });
});

describe("SPACING_TOKENS", () => {
  it("contains exactly the spec's 4px spacing grid values", () => {
    expect(Object.values(SPACING_TOKENS).sort((a, b) => a - b)).toEqual(SPEC_SPACING_PX);
  });

  it("declares every spacing token in tokens.css", () => {
    for (const [name, px] of Object.entries(SPACING_TOKENS)) {
      expect(tokensCss).toContain(`${name}: ${px}px;`);
    }
  });
});

describe("RADIUS_TOKENS", () => {
  it("contains exactly the spec's radius scale values", () => {
    expect(Object.values(RADIUS_TOKENS).sort((a, b) => a - b)).toEqual(SPEC_RADIUS_PX);
  });

  it("declares every radius token in tokens.css", () => {
    for (const [name, px] of Object.entries(RADIUS_TOKENS)) {
      expect(tokensCss).toContain(`${name}: ${px}px;`);
    }
  });
});
