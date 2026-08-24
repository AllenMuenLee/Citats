/**
 * @ai-browser/contracts -- canonical tool-call contract schemas shared
 * between apps/desktop (Electron main/preload), apps/renderer
 * (orchestrator), and services/browser (browser service).
 *
 * This package is the single source of truth per ADR 0004
 * (`docs/architecture/decisions/0004-canonical-schema-ownership.md`):
 * TypeScript types + Zod runtime schemas here, with JSON Schema generated
 * to `schema/*.json` (`npm run generate:schema`) and Pydantic models
 * generated into `services/browser/src/browser_service/contracts/` from
 * that committed JSON Schema. See
 * `docs/features/p00-f03-tool-contract.md` for the full write-up.
 */

export * from "./version";
export * from "./primitives";
export * from "./security/credential-guard";
export * from "./correlation";
export * from "./sensitivity";
export * from "./evidence";
export * from "./citation";
export * from "./errors";
export * from "./tool-definition";
export * from "./tools/system-echo";
export * from "./tools/navigate-and-extract";
export * from "./invocation";
export * from "./results";
export * from "./progress";
export * from "./cancellation";
