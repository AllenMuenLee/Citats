export type ChatStatus = "idle" | "streaming" | "stopped" | "failed" | "completed";
type MessagePartBase = { id: string };
export type UserPart = MessagePartBase & { type: "user"; text: string };
/** An inline citation reference anchored to a position within an `AssistantPart`'s accumulated `text`. */
export type CitationMarker = { id: string; citationId: string; sourceId: string; position: number };
export type AssistantPart = MessagePartBase & { type: "assistant"; text: string; citations?: CitationMarker[] };
export type ToolStatusPart = MessagePartBase & { type: "tool-status"; label: string; state: "running" | "completed" | "failed"; url?: string; response?: string; reason?: string };
export type ErrorPart = MessagePartBase & { type: "error"; message: string; retryable: boolean };
export type ArtifactPart = MessagePartBase & { type: "artifact"; artifactType: "image" | "file" | "source"; title: string; url?: string; mediaType?: string };
export type GeneratedUiPart = MessagePartBase & { type: "generated-ui"; instanceId: string; artifactId: string; inputDigest: string; observationDigest: string; revision: number; expiresAt: string; displayProps: Readonly<Record<string, unknown>>; sourceCount: number; coverageLabel: string; fallbackText: string };
/** A source cited somewhere in a completed answer: title, destination origin, and retrieval time (see docs/desktop-architecture-and-ui-specification.md's citation requirements). */
export type CitationSource = { id: string; url: string; title: string; retrievedAt: string };
export type CitationSourcesPart = MessagePartBase & { type: "citation-sources"; sources: CitationSource[] };
export type ChatPart = UserPart | AssistantPart | ToolStatusPart | ArtifactPart | GeneratedUiPart | ErrorPart | CitationSourcesPart;
export type ChatStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-status"; id?: string; label: string; state: ToolStatusPart["state"]; url?: string; response?: string; reason?: string }
  | { type: "artifact"; id: string; artifactType: ArtifactPart["artifactType"]; title: string; url?: string; mediaType?: string }
  | GeneratedUiPart
  | { type: "error"; message: string; retryable?: boolean }
  | { type: "citation-marker"; id: string; citationId: string; sourceId: string; position: number }
  | { type: "citation-sources"; id: string; sources: CitationSource[] }
  | { type: "done" };
