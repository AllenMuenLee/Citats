import { createHash } from "node:crypto";
import { CompiledGeneratedUiArtifactSchema, type CompiledGeneratedUiArtifact } from "@ai-browser/contracts";

export interface UiArtifactCacheIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly inputDigest: string;
  readonly promptDigest: string;
  readonly modelIdentifier: string;
  readonly runtimeVersion: string;
  readonly compilerVersion: string;
}

export function uiArtifactCacheKey(identity: UiArtifactCacheIdentity): string {
  const versionInput = JSON.stringify({
    compilerVersion: identity.compilerVersion,
    inputDigest: identity.inputDigest,
    modelIdentifier: identity.modelIdentifier,
    promptDigest: identity.promptDigest,
    runtimeVersion: identity.runtimeVersion,
  });
  return createHash("sha256").update(versionInput, "utf8").digest("hex");
}

interface Entry { artifact: CompiledGeneratedUiArtifact; expiresAtMs: number; byteSize: number }

export class ImmutableUiArtifactCache {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(private readonly options: { maxEntries: number; maxBytes: number; ttlMs: number; now?: () => number }) {}

  private scopedKey(identity: UiArtifactCacheIdentity): string {
    return `${identity.tenantId}\0${identity.userId}\0${uiArtifactCacheKey(identity)}`;
  }

  get(identity: UiArtifactCacheIdentity): CompiledGeneratedUiArtifact | undefined {
    const key = this.scopedKey(identity);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= (this.options.now?.() ?? Date.now())) {
      this.entries.delete(key);
      this.totalBytes -= entry.byteSize;
      return undefined;
    }
    return entry.artifact;
  }

  putValidated(identity: UiArtifactCacheIdentity, value: unknown): void {
    const artifact = CompiledGeneratedUiArtifactSchema.parse(value);
    if (!artifact.validation.valid || artifact.validation.issues.some((issue) => issue.severity === "error")) {
      throw new Error("Only fully validated compiled artifacts may be cached");
    }
    const key = this.scopedKey(identity);
    if (this.entries.has(key)) return;
    const byteSize = Buffer.byteLength(JSON.stringify(artifact), "utf8");
    if (byteSize > this.options.maxBytes) throw new Error("Artifact exceeds cache size bound");
    while (this.entries.size >= this.options.maxEntries || this.totalBytes + byteSize > this.options.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      const removed = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.totalBytes -= removed.byteSize;
    }
    const expiresAtMs = Math.min(Date.parse(artifact.expiresAt), (this.options.now?.() ?? Date.now()) + this.options.ttlMs);
    this.entries.set(key, { artifact, expiresAtMs, byteSize });
    this.totalBytes += byteSize;
  }
}
