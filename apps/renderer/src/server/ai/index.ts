import "server-only";

import type { ModelRoleConfig } from "./config";
import { createGeminiAdapter, createGeminiCompletion } from "./gemini/adapter";
import { createGroqAdapter, createGroqCompletion } from "./groq/adapter";
import type { ModelAdapter, ModelAdapterOptions, TextCompletion } from "./types";

/**
 * Builds the streaming adapter for one configured role. This is the only
 * place a provider name is turned into an implementation -- every caller
 * above it holds a `ModelAdapter` and cannot tell which provider answered.
 */
export function createModelAdapter(role: ModelRoleConfig, options: ModelAdapterOptions = {}): ModelAdapter {
  return role.provider === "gemini"
    ? createGeminiAdapter(role, options)
    : createGroqAdapter(role, options);
}

/** Builds the non-streaming, schema-constrained completion used by the UI-generation agent. */
export function createTextCompletion(role: ModelRoleConfig, fetchImpl: typeof fetch = fetch): TextCompletion {
  return role.provider === "gemini"
    ? createGeminiCompletion(role, fetchImpl)
    : createGroqCompletion(role, fetchImpl);
}

export { createGeminiAdapter, createGeminiCompletion } from "./gemini/adapter";
export { createGroqAdapter, createGroqCompletion } from "./groq/adapter";
export {
  AiConfigError,
  readAiConfig,
  type AiConfig,
  type ModelRoleConfig,
  type ProviderCredentials,
  type TransportConfig,
} from "./config";
export {
  MODEL_PROVIDERS,
  ModelProviderError,
  SAFE_ERROR_MESSAGES,
  providerError,
  type ConversationTurn,
  type HostedToolName,
  type ModelAdapter,
  type ModelAdapterOptions,
  type ModelArtifact,
  type ModelErrorCode,
  type ModelMetrics,
  type ModelProviderName,
  type ModelResponseFormat,
  type ModelStreamEvent,
  type ModelStreamRequest,
  type ModelToolDefinition,
  type TextCompletion,
  type TextCompletionRequest,
  type TextCompletionResult,
} from "./types";
