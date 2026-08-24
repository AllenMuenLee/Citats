/**
 * Generates the committed JSON Schema build artifacts under
 * `packages/contracts/schema/*.schema.json` from the Zod schemas in
 * `packages/contracts/src/`.
 *
 * Usage:
 *   npm run generate:schema            -- regenerate schema/*.schema.json in place
 *   npm run check:schema               -- (or: generate:schema -- --check)
 *                                          regenerate into a temp dir and diff
 *                                          against the committed files; exits
 *                                          non-zero on any drift (missing,
 *                                          extra, or changed file).
 *
 * Output is deterministic: object keys are sorted recursively before
 * serialization, so running this script twice in a row with no source
 * changes produces byte-identical files (verified in
 * `docs/features/p00-f03-tool-contract.md`'s validation section).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  CancellationRequestSchema,
  CancellationResultSchema,
  CorrelationMetadataSchema,
  EvidenceItemSchema,
  NavigateAndExtractInvocationSchema,
  NavigateAndExtractSuccessResultSchema,
  InvokeDiscoveredApiInvocationSchema,
  InvokeDiscoveredApiSuccessResultSchema,
  SensitivityFlagsSchema,
  SystemEchoInvocationSchema,
  SystemEchoProgressEventSchema,
  SystemEchoSuccessResultSchema,
  ToolDefinitionSchema,
  ToolErrorResultSchema,
  flightComparisonPropsSchema,
  generativeUiPartSchema,
  productResultPropsSchema,
  uiCommandSchema,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, "..", "schema");

/**
 * Registry of every schema this package publishes as a JSON Schema build
 * artifact. Keys become the file basename (`<key>.schema.json`) and are
 * also what `services/browser/scripts/generate_contracts.py` reads to
 * name the generated Pydantic modules -- keep the two in sync.
 */
const REGISTRY: Record<string, z.ZodTypeAny> = {
  "tool-definition": ToolDefinitionSchema,
  "correlation-metadata": CorrelationMetadataSchema,
  sensitivity: SensitivityFlagsSchema,
  "evidence-item": EvidenceItemSchema,
  "error-result": ToolErrorResultSchema,
  "invocation-system-echo": SystemEchoInvocationSchema,
  "success-result-system-echo": SystemEchoSuccessResultSchema,
  "progress-event-system-echo": SystemEchoProgressEventSchema,
  "invocation-navigate-and-extract": NavigateAndExtractInvocationSchema,
  "success-result-navigate-and-extract": NavigateAndExtractSuccessResultSchema,
  "invocation-invoke-discovered-api": InvokeDiscoveredApiInvocationSchema,
  "success-result-invoke-discovered-api": InvokeDiscoveredApiSuccessResultSchema,
  "cancellation-request": CancellationRequestSchema,
  "cancellation-result": CancellationResultSchema,
  "flight-comparison-props": flightComparisonPropsSchema,
  "generative-ui-part": generativeUiPartSchema,
  "product-result-props": productResultPropsSchema,
  "ui-command": uiCommandSchema,
};

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function fileNameFor(registryKey: string): string {
  return `${registryKey}.schema.json`;
}

/** Regenerates every registered schema as a JSON Schema file into `targetDir`. Returns the file names written. */
function generateAll(targetDir: string): string[] {
  mkdirSync(targetDir, { recursive: true });
  const fileNames: string[] = [];
  for (const key of Object.keys(REGISTRY).sort((a, b) => a.localeCompare(b))) {
    const jsonSchema = z.toJSONSchema(REGISTRY[key], { target: "draft-7" });
    const fileName = fileNameFor(key);
    writeFileSync(join(targetDir, fileName), stableStringify(jsonSchema), "utf8");
    fileNames.push(fileName);
  }
  return fileNames;
}

function listCommittedSchemaFiles(): string[] {
  if (!existsSync(SCHEMA_DIR)) {
    return [];
  }
  return readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json"));
}

function runGenerate(): void {
  const files = generateAll(SCHEMA_DIR);
  console.log(`Generated ${files.length} JSON Schema file(s) into ${SCHEMA_DIR}:`);
  for (const f of files) {
    console.log(`  ${f}`);
  }
}

function runCheck(): void {
  const tmpDir = mkdtempSync(join(tmpdir(), "ai-browser-contracts-schema-check-"));
  let drift = false;
  try {
    const freshFiles = new Set(generateAll(tmpDir));
    const committedFiles = new Set(listCommittedSchemaFiles());

    for (const fileName of freshFiles) {
      if (!committedFiles.has(fileName)) {
        console.error(`DRIFT: ${fileName} would be generated but is missing from ${SCHEMA_DIR}`);
        drift = true;
        continue;
      }
      const committed = readFileSync(join(SCHEMA_DIR, fileName), "utf8");
      const fresh = readFileSync(join(tmpDir, fileName), "utf8");
      if (committed !== fresh) {
        console.error(`DRIFT: ${fileName} does not match what src/ currently generates`);
        drift = true;
      }
    }
    for (const fileName of committedFiles) {
      if (!freshFiles.has(fileName)) {
        console.error(`DRIFT: ${fileName} is committed but no longer generated by src/ (stale file)`);
        drift = true;
      }
    }

    if (drift) {
      console.error("\nSchema check FAILED. Run `npm run generate:schema` and commit the result.");
      process.exitCode = 1;
    } else {
      console.log(`Schema check passed: ${SCHEMA_DIR} matches what src/ currently generates.`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const checkMode = process.argv.includes("--check");
if (checkMode) {
  runCheck();
} else {
  runGenerate();
}
