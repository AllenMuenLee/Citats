export type MistralErrorCode =
  | "AI_AUTHENTICATION_FAILED"
  | "AI_RATE_LIMITED"
  | "AI_TIMEOUT"
  | "AI_MALFORMED_RESPONSE"
  | "AI_SAFETY_REFUSAL"
  | "AI_PROVIDER_UNAVAILABLE";

export class MistralProviderError extends Error {
  override readonly name = "MistralProviderError";

  constructor(
    readonly code: MistralErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface MistralTextDelta {
  type: "text-delta";
  text: string;
}

export interface MistralToolCallDelta {
  type: "tool-call-delta";
  index: number;
  id?: string;
  name?: string;
  argumentsDelta: string;
}

export interface MistralUsage {
  type: "usage";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface MistralFinish {
  type: "finish";
  reason: string;
}

export interface MistralRequestMetadata {
  type: "request-metadata";
  providerRequestId: string;
}

export type MistralHostedToolName = "code_interpreter" | "image_generation" | "web_search";

export interface MistralHostedToolStatus {
  type: "hosted-tool-status";
  id: string;
  name: MistralHostedToolName;
  state: "running" | "completed";
}

export interface MistralArtifact {
  type: "artifact";
  artifactType: "image" | "file" | "source";
  url?: string;
  fileId?: string;
  title: string;
  mediaType?: string;
}

export type MistralStreamEvent =
  | MistralTextDelta
  | MistralToolCallDelta
  | MistralUsage
  | MistralFinish
  | MistralRequestMetadata
  | MistralHostedToolStatus
  | MistralArtifact;

export interface MistralConversationTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: readonly {
    id: string;
    name: string;
    arguments: string;
  }[];
}

export interface MistralToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Requests structured JSON output (Mistral's `response_format: json_schema`
 * mode) instead of free text. Used by the routing classifier
 * (`server/orchestrator/routing.ts`) to get a closed-schema decision back
 * without exposing any tools to that call.
 */
export interface MistralResponseFormat {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface MistralStreamRequest {
  correlationId: string;
  systemInstruction: string;
  turns: readonly MistralConversationTurn[];
  tools?: readonly MistralToolDefinition[];
  /** Hosted tools to enable for this request only -- never enabled implicitly (see P02-R01/P02-R03). */
  hostedTools?: readonly MistralHostedToolName[];
  responseFormat?: MistralResponseFormat;
  signal?: AbortSignal;
}

export interface MistralMetrics {
  correlationId: string;
  durationMs: number;
  timeToFirstTokenMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  attemptCount: number;
  errorCode?: MistralErrorCode;
}

export interface MistralAdapter {
  stream(request: MistralStreamRequest): AsyncIterable<MistralStreamEvent>;
}
