/**
 * Provider-agnostic model contract.
 *
 * Everything above this file (the orchestrator, the routing classifier, the
 * observation digest, the UI-generation adapter) speaks only these types.
 * Each provider package under `server/ai/<provider>/` translates them to and
 * from that vendor's wire format, so switching `CHAT_MODEL_PROVIDER` between
 * `gemini` and `groq` never reaches a caller.
 */
export const MODEL_PROVIDERS = ["gemini", "groq"] as const;
export type ModelProviderName = (typeof MODEL_PROVIDERS)[number];

export type ModelErrorCode =
  | "AI_AUTHENTICATION_FAILED"
  | "AI_RATE_LIMITED"
  | "AI_TIMEOUT"
  | "AI_MALFORMED_RESPONSE"
  | "AI_REQUEST_REJECTED"
  | "AI_SAFETY_REFUSAL"
  | "AI_PROVIDER_UNAVAILABLE";

export class ModelProviderError extends Error {
  override readonly name = "ModelProviderError";

  constructor(
    readonly code: ModelErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Fallback text for every error code, used when the provider stated no
 * reason of its own. Never carries provider payloads, keys, or page content.
 */
export const SAFE_ERROR_MESSAGES: Readonly<Record<ModelErrorCode, string>> = Object.freeze({
  AI_AUTHENTICATION_FAILED: "The AI service credentials were rejected.",
  AI_RATE_LIMITED: "The AI service is temporarily busy. Please try again.",
  AI_TIMEOUT: "The AI response timed out. Please try again.",
  AI_MALFORMED_RESPONSE: "The AI service returned an invalid response.",
  AI_REQUEST_REJECTED: "The AI service rejected this request as invalid.",
  AI_SAFETY_REFUSAL: "The AI service declined this request for safety reasons.",
  AI_PROVIDER_UNAVAILABLE: "The AI service is temporarily unavailable.",
});

/**
 * Builds the error the caller sees. `detail` is the provider's own reason
 * -- Gemini's `error.message`, Groq's -- and replaces the generic text when
 * present, so a rejected request reports what the provider actually said
 * instead of a summary this app guessed at. Only that one field is carried:
 * the rest of an error body may quote the model's rejected output, which can
 * contain untrusted page content.
 */
export function providerError(
  code: ModelErrorCode,
  cause?: unknown,
  detail?: string,
): ModelProviderError {
  const message = detail?.trim() ? detail.trim() : SAFE_ERROR_MESSAGES[code];
  return new ModelProviderError(code, message, cause === undefined ? undefined : { cause });
}

export interface ModelTextDelta {
  type: "text-delta";
  text: string;
}

export interface ModelToolCallDelta {
  type: "tool-call-delta";
  index: number;
  id?: string;
  name?: string;
  argumentsDelta: string;
  /**
   * Opaque provider-issued token that must be echoed back verbatim when this
   * call is replayed in a later request's history. Gemini 3.x returns a
   * `thoughtSignature` alongside every `functionCall` part and rejects the
   * next request outright ("Function call is missing a thought_signature in
   * functionCall parts") if it is not returned -- which made every tool loop
   * fail with HTTP 400 on its second step, after exactly one successful tool
   * call. Modelled as one opaque string rather than a Gemini-shaped field so
   * a provider without the concept simply never sets it.
   */
  signature?: string;
}

export interface ModelUsage {
  type: "usage";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelFinish {
  type: "finish";
  reason: string;
}

export interface ModelRequestMetadata {
  type: "request-metadata";
  providerRequestId: string;
}

/**
 * Hosted (provider-executed) tools. Only web search is portable across both
 * providers -- Gemini runs it as its built-in `google_search` grounding tool,
 * Groq as its built-in `browser_search` tool -- so it is the only one the
 * abstraction exposes. Nothing else is ever enabled implicitly.
 */
export type HostedToolName = "web_search";

export interface ModelHostedToolStatus {
  type: "hosted-tool-status";
  id: string;
  name: HostedToolName;
  state: "running" | "completed";
  output?: string;
}

export interface ModelArtifact {
  type: "artifact";
  artifactType: "image" | "file" | "source";
  url?: string;
  title: string;
  mediaType?: string;
}

export type ModelStreamEvent =
  | ModelTextDelta
  | ModelToolCallDelta
  | ModelUsage
  | ModelFinish
  | ModelRequestMetadata
  | ModelHostedToolStatus
  | ModelArtifact;

export interface ConversationTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: readonly {
    id: string;
    name: string;
    arguments: string;
    /** Echoed back verbatim when this turn is replayed -- see `ModelToolCallDelta.signature`. */
    signature?: string;
  }[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
}

/**
 * Requests structured JSON output instead of free text -- Gemini's
 * `responseJsonSchema`, Groq's `response_format: json_schema`. Used by the
 * routing classifier (`server/orchestrator/routing.ts`) and the observation
 * digest to get a closed-schema answer back without exposing any tool.
 */
export interface ModelResponseFormat {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface ModelStreamRequest {
  correlationId: string;
  systemInstruction: string;
  turns: readonly ConversationTurn[];
  tools?: readonly ModelToolDefinition[];
  /** Hosted tools to enable for this request only -- never enabled implicitly. */
  hostedTools?: readonly HostedToolName[];
  responseFormat?: ModelResponseFormat;
  signal?: AbortSignal;
}

export interface ModelMetrics {
  correlationId: string;
  durationMs: number;
  timeToFirstTokenMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  attemptCount: number;
  errorCode?: ModelErrorCode;
}

export interface ModelAdapter {
  readonly provider?: ModelProviderName;
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent>;
}

/**
 * One non-streaming completion. Callers may request provider-enforced
 * structured output, but prompt-only callers omit `responseFormat`.
 */
export interface TextCompletionRequest {
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly systemInstruction: string;
  readonly userContent: string;
  readonly hostedTools?: readonly HostedToolName[];
  readonly responseFormat?: ModelResponseFormat;
}

export interface TextCompletionResult {
  readonly model: string;
  readonly content: string;
}

export type TextCompletion = (
  request: TextCompletionRequest,
  signal: AbortSignal,
) => Promise<TextCompletionResult>;

export interface ModelAdapterOptions {
  fetchImpl?: typeof fetch;
  emitMetrics?: (metrics: ModelMetrics) => void;
  random?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
