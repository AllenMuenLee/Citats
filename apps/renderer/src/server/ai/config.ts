import "server-only";

import { z } from "zod";

import { MODEL_PROVIDERS, type ModelProviderName } from "./types";

/**
 * Default API roots per provider. Both are HTTPS and credential-free; the
 * schema below re-checks that for any override so a misconfigured
 * `*_API_BASE_URL` can never downgrade the transport or smuggle a key into
 * the URL.
 */
const DEFAULT_BASE_URLS: Readonly<Record<ModelProviderName, string>> = Object.freeze({
  gemini: "https://generativelanguage.googleapis.com/v1beta/",
  groq: "https://api.groq.com/openai/v1/",
});

const ProviderNameSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(MODEL_PROVIDERS));

const BaseUrlSchema = z.url().transform((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    context.addIssue({ code: "custom", message: "must be an HTTPS URL without credentials" });
    return z.NEVER;
  }
  return url;
});

const TransportSchema = z.object({
  timeoutMs: z.coerce.number().int().min(1_000).max(300_000),
  maxRetries: z.coerce.number().int().min(0).max(5),
  /**
   * Total wall-clock budget for retrying a rate-limited or 5xx request,
   * kept independent of `timeoutMs` (which bounds a single attempt). A
   * `Retry-After` is honored verbatim, so one rate-limit wait must not be
   * able to exhaust a single attempt's budget and surface as a failure even
   * though the server said exactly how long to wait.
   */
  retryMaxElapsedMs: z.coerce.number().int().min(1_000).max(600_000),
});

export type TransportConfig = z.infer<typeof TransportSchema>;

const CredentialsSchema = z.object({
  provider: ProviderNameSchema,
  apiKey: z.string().trim().min(1),
  baseUrl: BaseUrlSchema,
});

export type ProviderCredentials = z.infer<typeof CredentialsSchema>;

const ModelRoleSchema = CredentialsSchema.extend({
  model: z.string().trim().min(1).max(100),
}).and(TransportSchema);

/** A fully resolved provider + model + transport triple for one role. */
export type ModelRoleConfig = z.infer<typeof ModelRoleSchema>;

/**
 * The four model roles this app runs, each independently pointed at either
 * provider. Only `chat` ever talks to the user or is offered a tool; the
 * other three are internal stages of `ui.generate` and are given no tools of
 * any kind, no conversation history, and temperature zero.
 *
 * - `chat` answers the user and may call `ui.generate`
 *   (`CHAT_MODEL_PROVIDER` / `CHAT_MODEL`).
 * - `sourceFinding` turns the user's request into a structured list of
 *   candidate websites (`SOURCE_FINDING_MODEL_PROVIDER` /
 *   `SOURCE_FINDING_MODEL`). It never decides URL safety -- trusted code
 *   does, in `server/ui-generate/source-finding/url-policy.ts`.
 * - `uiPlanning` reads every successful rendered-HTML capture and returns
 *   one validated `UiPlan` (`UI_PLANNING_MODEL_PROVIDER` /
 *   `UI_PLANNING_MODEL`).
 * - `ui` writes the React component from that plan (`UI_MODEL_PROVIDER` /
 *   `UI_MODEL`).
 *
 * Only `chat` is required. `ui.generate` needs all three internal roles: if
 * any is unset the tool is not offered at all, rather than being offered and
 * then failing every call.
 */
export interface AiConfig {
  chat: ModelRoleConfig;
  sourceFinding?: ModelRoleConfig;
  uiPlanning?: ModelRoleConfig;
  ui?: ModelRoleConfig;
}

type Environment = Readonly<Record<string, string | undefined>>;

const API_KEY_VARIABLE: Readonly<Record<ModelProviderName, string>> = Object.freeze({
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
});

const BASE_URL_VARIABLE: Readonly<Record<ModelProviderName, string>> = Object.freeze({
  gemini: "GEMINI_API_BASE_URL",
  groq: "GROQ_API_BASE_URL",
});

export class AiConfigError extends Error {
  override readonly name = "AiConfigError";
}

function readTransport(environment: Environment): TransportConfig {
  const parsed = TransportSchema.safeParse({
    timeoutMs: environment.AI_TIMEOUT_MS ?? "60000",
    maxRetries: environment.AI_MAX_RETRIES ?? "2",
    retryMaxElapsedMs: environment.AI_RETRY_MAX_ELAPSED_MS ?? "120000",
  });
  if (!parsed.success) {
    throw new AiConfigError(`AI transport configuration is invalid (${fieldList(parsed.error)}).`);
  }
  return parsed.data;
}

function fieldList(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => issue.path[0]).filter(Boolean))].join(", ");
}

/**
 * Resolves one role. Returns `undefined` only when the role is entirely
 * unset (both variables absent) and optional -- a half-configured role is an
 * error rather than a silent downgrade, since an unnoticed missing model
 * would look identical to a deliberately disabled feature.
 */
function readRole(
  environment: Environment,
  role: "CHAT" | "SOURCE_FINDING" | "UI_PLANNING" | "UI",
  transport: TransportConfig,
  required: boolean,
): ModelRoleConfig | undefined {
  const providerValue = environment[`${role}_MODEL_PROVIDER`];
  const modelValue = environment[`${role}_MODEL`];
  if (!providerValue?.trim() && !modelValue?.trim()) {
    if (!required) return undefined;
    throw new AiConfigError(`${role}_MODEL_PROVIDER and ${role}_MODEL must be set.`);
  }
  const provider = ProviderNameSchema.safeParse(providerValue ?? "");
  if (!provider.success) {
    throw new AiConfigError(`${role}_MODEL_PROVIDER must be one of: ${MODEL_PROVIDERS.join(", ")}.`);
  }
  const parsed = ModelRoleSchema.safeParse({
    provider: provider.data,
    model: modelValue,
    apiKey: environment[API_KEY_VARIABLE[provider.data]],
    baseUrl: environment[BASE_URL_VARIABLE[provider.data]] ?? DEFAULT_BASE_URLS[provider.data],
    ...transport,
  });
  if (!parsed.success) {
    const fields = fieldList(parsed.error)
      .replace("apiKey", API_KEY_VARIABLE[provider.data])
      .replace("baseUrl", BASE_URL_VARIABLE[provider.data])
      .replace("model", `${role}_MODEL`);
    throw new AiConfigError(`${role} model configuration is invalid (${fields}).`);
  }
  return parsed.data;
}

export function readAiConfig(environment: Environment = process.env): AiConfig {
  const transport = readTransport(environment);
  return {
    chat: readRole(environment, "CHAT", transport, true)!,
    sourceFinding: readRole(environment, "SOURCE_FINDING", transport, false),
    uiPlanning: readRole(environment, "UI_PLANNING", transport, false),
    ui: readRole(environment, "UI", transport, false),
  };
}
