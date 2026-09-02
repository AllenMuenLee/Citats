export type ChatStatus = "idle" | "streaming" | "stopped" | "failed" | "completed";
type MessagePartBase = { id: string };
export type UserPart = MessagePartBase & { type: "user"; text: string };
/** An inline citation reference anchored to a position within an `AssistantPart`'s accumulated `text`. */
export type CitationMarker = { id: string; citationId: string; sourceId: string; position: number };
export type AssistantPart = MessagePartBase & { type: "assistant"; text: string; citations?: CitationMarker[] };
export type ToolStatusPart = MessagePartBase & { type: "tool-status"; label: string; state: "running" | "completed" | "failed"; response?: string; reason?: string };
/** A bounded `ui.generate` stage transition. Carries a label and nothing about what any stage actually read. */
export type ToolProgressPart = MessagePartBase & { type: "tool-progress"; toolCallId: string; state: string; label: string };
export type ErrorPart = MessagePartBase & { type: "error"; message: string; retryable: boolean };

/** The opaque instance the pane mounts. No HTML, no TSX, no plan, no URL. */
export type GeneratedView = {
  instanceId: string;
  artifactId: string;
  planDigest: string;
  inputDigest: string;
  revision: number;
  expiresAt: string;
  title: string;
  sourceCount: number;
  coverage: "validated" | "partial";
  fallbackText: string;
};
export type GeneratedUiPart = MessagePartBase & { type: "generated-ui"; view: GeneratedView; displayProps?: unknown };
/** A source cited somewhere in a completed answer: title, destination origin, and retrieval time. */
export type CitationSource = { id: string; url: string; title: string; retrievedAt: string };
export type CitationSourcesPart = MessagePartBase & { type: "citation-sources"; sources: CitationSource[] };
export type ChatPart = UserPart | AssistantPart | ToolStatusPart | ToolProgressPart | GeneratedUiPart | ErrorPart | CitationSourcesPart;

export type ChatStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-status"; id?: string; label: string; state: ToolStatusPart["state"]; response?: string; reason?: string }
  | { type: "tool-progress"; id: string; toolCallId: string; state: string; label: string }
  | { type: "generated-ui"; id: string; view: GeneratedView }
  | { type: "error"; message: string; retryable?: boolean }
  | { type: "citation-marker"; id: string; citationId: string; sourceId: string; position: number }
  | { type: "citation-sources"; id: string; sources: CitationSource[] }
  | { type: "done" };
