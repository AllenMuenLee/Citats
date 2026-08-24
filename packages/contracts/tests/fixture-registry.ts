/**
 * Maps each `fixtures/<name>/` directory to the Zod schema fixtures in
 * that directory are validated against. Shared by `tests/fixtures.test.ts`
 * (Vitest) and referenced by name (not import -- Python can't import a TS
 * module) from
 * `services/browser/tests/test_contracts_fixtures.py`, which re-derives
 * the same directory list by walking `packages/contracts/fixtures/`
 * directly. Keep the directory names here in sync with the fixtures/
 * directory tree and with `services/browser/src/browser_service/contracts/`
 * so both languages walk the identical fixture set.
 */
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
  generativeUiPartSchema,
  uiCommandSchema,
} from "../src/index.js";

export const FIXTURE_SCHEMA_REGISTRY: Record<string, z.ZodTypeAny> = {
  "tool-definition": ToolDefinitionSchema,
  invocation: SystemEchoInvocationSchema,
  "success-result": SystemEchoSuccessResultSchema,
  "error-result": ToolErrorResultSchema,
  "progress-event": SystemEchoProgressEventSchema,
  "cancellation-request": CancellationRequestSchema,
  "cancellation-result": CancellationResultSchema,
  evidence: EvidenceItemSchema,
  sensitivity: SensitivityFlagsSchema,
  "correlation-metadata": CorrelationMetadataSchema,
  "invocation-navigate-and-extract": NavigateAndExtractInvocationSchema,
  "success-result-navigate-and-extract": NavigateAndExtractSuccessResultSchema,
  "invocation-invoke-discovered-api": InvokeDiscoveredApiInvocationSchema,
  "success-result-invoke-discovered-api": InvokeDiscoveredApiSuccessResultSchema,
  "generative-ui-part": generativeUiPartSchema,
  "ui-command": uiCommandSchema,
};
