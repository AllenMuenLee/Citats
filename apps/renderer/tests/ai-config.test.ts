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
      SOURCE_FINDING_MODEL_PROVIDER: "gemini",
      SOURCE_FINDING_MODEL: "gemini-3.5-flash-lite",
      UI_MODEL_PROVIDER: "GROQ",
      UI_MODEL: "groq-ui",
    });

    expect(config.chat).toMatchObject({
      provider: "gemini",
      model: "gemini-3.5-flash",
      apiKey: "gemini-secret",
      baseUrl: new URL("https://generativelanguage.googleapis.com/v1beta/"),
    });
    expect(config.sourceFinding).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash-lite" });
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
    expect(config.sourceFinding).toBeUndefined();
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

  it("applies the shared retry count without a time budget", () => {
    const config = readAiConfig({
      ...base,
      SOURCE_FINDING_MODEL_PROVIDER: "groq",
      SOURCE_FINDING_MODEL: "groq-extraction",
      AI_MAX_RETRIES: "1",
    });
    for (const role of [config.chat, config.sourceFinding!]) {
      expect(role).toEqual(expect.objectContaining({ maxRetries: 1 }));
      expect(role).not.toHaveProperty("timeoutMs");
      expect(role).not.toHaveProperty("retryMaxElapsedMs");
    }
  });
});

describe("model selection", () => {
  const base = {
    GEMINI_API_KEY: "key",
    CHAT_MODEL_PROVIDER: "gemini",
    CHAT_MODEL: "gemini-3.5-flash",
  };

  // No model family is refused here any more. Which models a provider serves,
  // and with which capabilities, is the provider's fact and changes without
  // notice; a local guess at it refused working configurations and hid the
  // provider's own explanation behind a message this app invented. A model the
  // provider cannot run now fails on the request, reported in the provider's
  // own words.
  it("accepts any model name for any role, leaving the verdict to the provider", () => {
    expect(() => readAiConfig({ ...base, CHAT_MODEL: "gemma-4-31b-it" })).not.toThrow();
    expect(() => readAiConfig({ ...base, SOURCE_FINDING_MODEL_PROVIDER: "gemini", SOURCE_FINDING_MODEL: "gemma-4-26b-a4b-it" }))
      .not.toThrow();
    expect(() => readAiConfig({ ...base, UI_MODEL_PROVIDER: "gemini", UI_MODEL: "gemma-4-31b-it" })).not.toThrow();
  });

  it("keeps the model string as written, including a models/ prefix", () => {
    expect(readAiConfig({ ...base, CHAT_MODEL: "models/gemini-3.5-flash" }).chat.model).toBe("models/gemini-3.5-flash");
  });
});
