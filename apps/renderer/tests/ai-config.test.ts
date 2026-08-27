import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readAiConfig } from "../src/server/ai";

const base = {
  GEMINI_API_KEY: "gemini-secret",
  GROQ_API_KEY: "groq-secret",
  CHAT_MODEL_PROVIDER: "Gemini",
  CHAT_MODEL: "gemini-3.5-flash",
};

describe("AI provider configuration", () => {
  it("resolves each role independently and accepts a provider name in any casing", () => {
    const config = readAiConfig({
      ...base,
      EXTRACTION_MODEL_PROVIDER: "gemini",
      EXTRACTION_MODEL: "gemini-3.5-flash-lite",
      UI_MODEL_PROVIDER: "GROQ",
      UI_MODEL: "groq-ui",
    });

    expect(config.chat).toMatchObject({
      provider: "gemini",
      model: "gemini-3.5-flash",
      apiKey: "gemini-secret",
      baseUrl: new URL("https://generativelanguage.googleapis.com/v1beta/"),
    });
    expect(config.extraction).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash-lite" });
    // Roles are independent: the UI role picks up Groq's own key and base URL.
    expect(config.ui).toMatchObject({
      provider: "groq",
      model: "groq-ui",
      apiKey: "groq-secret",
      baseUrl: new URL("https://api.groq.com/openai/v1/"),
    });
  });

  it("leaves the optional roles unset when neither of their variables is present", () => {
    const config = readAiConfig(base);
    expect(config.extraction).toBeUndefined();
    expect(config.ui).toBeUndefined();
  });

  it("rejects a half-configured optional role rather than silently disabling it", () => {
    expect(() => readAiConfig({ ...base, UI_MODEL: "groq-ui" }))
      .toThrow("UI_MODEL_PROVIDER must be one of: gemini, groq.");
  });

  it("requires the chat role and the key of the provider it names", () => {
    expect(() => readAiConfig({ GEMINI_API_KEY: "k" }))
      .toThrow("CHAT_MODEL_PROVIDER and CHAT_MODEL must be set.");
    expect(() => readAiConfig({ CHAT_MODEL_PROVIDER: "Groq", CHAT_MODEL: "m" }))
      .toThrow("CHAT model configuration is invalid (GROQ_API_KEY).");
  });

  it("rejects an unknown provider and a base URL that is not credential-free HTTPS", () => {
    expect(() => readAiConfig({ ...base, CHAT_MODEL_PROVIDER: "openai" }))
      .toThrow("CHAT_MODEL_PROVIDER must be one of: gemini, groq.");
    expect(() => readAiConfig({ ...base, GEMINI_API_BASE_URL: "http://gemini.example/v1/" }))
      .toThrow("CHAT model configuration is invalid (GEMINI_API_BASE_URL).");
    expect(() => readAiConfig({ ...base, GEMINI_API_BASE_URL: "https://user:pass@gemini.example/v1/" }))
      .toThrow("CHAT model configuration is invalid (GEMINI_API_BASE_URL).");
  });

  it("applies the shared transport budget to every role", () => {
    const config = readAiConfig({
      ...base,
      EXTRACTION_MODEL_PROVIDER: "groq",
      EXTRACTION_MODEL: "groq-extraction",
      AI_TIMEOUT_MS: "5000",
      AI_MAX_RETRIES: "1",
      AI_RETRY_MAX_ELAPSED_MS: "9000",
    });
    for (const role of [config.chat, config.extraction!]) {
      expect(role).toMatchObject({ timeoutMs: 5_000, maxRetries: 1, retryMaxElapsedMs: 9_000 });
    }
  });
});
