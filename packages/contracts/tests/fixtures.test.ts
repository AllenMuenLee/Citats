import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURE_SCHEMA_REGISTRY } from "./fixture-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "..", "fixtures");

function readJsonFixture(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("fixtures/", () => {
  const fixtureDirs = readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it("has a fixture directory for every registered schema type, and vice versa", () => {
    expect(fixtureDirs.sort()).toEqual(Object.keys(FIXTURE_SCHEMA_REGISTRY).sort());
  });

  for (const dirName of fixtureDirs) {
    const schema = FIXTURE_SCHEMA_REGISTRY[dirName];
    if (!schema) {
      continue;
    }
    const dirPath = join(FIXTURES_ROOT, dirName);
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".json"));
    const validFiles = files.filter((f) => f.startsWith("valid-"));
    const invalidFiles = files.filter((f) => f.startsWith("invalid-"));

    describe(dirName, () => {
      it("has at least one valid and two invalid fixtures", () => {
        expect(validFiles.length).toBeGreaterThanOrEqual(1);
        expect(invalidFiles.length).toBeGreaterThanOrEqual(2);
      });

      for (const file of validFiles) {
        it(`accepts ${file}`, () => {
          const data = readJsonFixture(join(dirPath, file));
          const result = schema.safeParse(data);
          if (!result.success) {
            throw new Error(
              `expected ${dirName}/${file} to be VALID but it was rejected: ${JSON.stringify(result.error.issues, null, 2)}`,
            );
          }
          expect(result.success).toBe(true);
        });
      }

      for (const file of invalidFiles) {
        it(`rejects ${file}`, () => {
          const data = readJsonFixture(join(dirPath, file));
          const result = schema.safeParse(data);
          expect(result.success).toBe(false);
          if (!result.success) {
            // Not just "didn't crash" -- assert there is at least one
            // concrete validation issue explaining the rejection.
            expect(result.error.issues.length).toBeGreaterThan(0);
          }
        });
      }
    });
  }
});
