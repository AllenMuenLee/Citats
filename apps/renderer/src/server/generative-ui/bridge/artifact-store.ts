import { CompiledGeneratedUiArtifactSchema, type CompiledGeneratedUiArtifact } from "@ai-browser/contracts";

type StoredArtifact = Readonly<{ artifact: CompiledGeneratedUiArtifact; bytes: Uint8Array }>;
const artifacts = new Map<string, StoredArtifact>();

export function registerGeneratedUiArtifact(value: unknown): void {
  const artifact = CompiledGeneratedUiArtifactSchema.parse(value);
  if (!artifact.validation.valid || artifact.module.kind !== "bytes") throw new Error("only validated inline compiled artifacts can be served");
  if (Date.parse(artifact.expiresAt) <= Date.now()) throw new Error("artifact expired");
  const bytes = Uint8Array.from(Buffer.from(artifact.module.value, "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength > 384_000) throw new Error("artifact byte size is invalid");
  artifacts.set(artifact.artifactId, { artifact, bytes });
}

export function getGeneratedUiArtifact(artifactId: string): StoredArtifact | null {
  const stored = artifacts.get(artifactId);
  if (!stored) return null;
  if (Date.parse(stored.artifact.expiresAt) <= Date.now()) { artifacts.delete(artifactId); return null; }
  return stored;
}
