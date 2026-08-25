export type UiGenerationValidationCategory = "accepted" | "parse" | "contract" | "pipeline" | "provider" | "timeout" | "cancelled";
export type UiGenerationCacheResult = "hit" | "miss" | "stored" | "rejected";

export interface UiGenerationMetric {
  readonly latencyMs: number;
  readonly validationCategory: UiGenerationValidationCategory;
  readonly cacheResult: UiGenerationCacheResult;
  readonly sourceBytes: number;
  readonly fallbackReason: string | null;
  readonly repaired: boolean;
}

export interface UiGenerationStabilityMetric {
  readonly cacheKey: string;
  readonly normalizedStructureDigest: string;
  readonly sourceDigest: string;
}
