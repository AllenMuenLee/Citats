import type { GeneratedUiArtifactManifest } from "@ai-browser/contracts";

export interface UiGenerationLimits {
  readonly maxSourceBytes: number;
  readonly maxAstNodes: number;
  readonly maxComplexity: number;
  readonly maxRenderNodes: number;
  readonly maxLocalStateEntries: number;
}

export interface StaticValidationIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly location: { readonly line: number; readonly column: number } | null;
}

export interface StaticValidationInput {
  readonly source: string;
  readonly manifest: GeneratedUiArtifactManifest;
  readonly limits: UiGenerationLimits;
  readonly allowedTokens: readonly string[];
}

export interface StaticValidationResult {
  readonly valid: boolean;
  readonly issues: readonly StaticValidationIssue[];
  readonly astNodes: number;
  readonly complexity: number;
  readonly maximumDepth: number;
  /** The runtime export names actually imported by the source, in first-seen order. */
  readonly imports: readonly string[];
}

export interface CompiledModule {
  readonly bytes: Uint8Array;
  readonly validation: StaticValidationResult;
  readonly toolchainVersion: string;
  readonly sourceMapPolicy: "omitted";
}
