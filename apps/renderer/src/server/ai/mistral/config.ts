import "server-only";

import { z } from "zod";

const MistralConfigSchema = z.object({
  apiKey: z.string().trim().min(1),
  model: z.string().trim().min(1).max(100),
  baseUrl: z.url().transform((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      context.addIssue({ code: "custom", message: "must be an HTTPS URL without credentials" });
      return z.NEVER;
    }
    return url;
  }),
  timeoutMs: z.coerce.number().int().min(1_000).max(300_000),
  maxRetries: z.coerce.number().int().min(0).max(5),
});

export type MistralConfig = z.infer<typeof MistralConfigSchema>;

export function readMistralConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MistralConfig {
  const parsed = MistralConfigSchema.safeParse({
    apiKey: environment.MISTRAL_API_KEY,
    model: environment.MISTRAL_MODEL ?? "mistral-medium-latest",
    baseUrl: environment.MISTRAL_API_BASE_URL ?? "https://api.mistral.ai/v1/",
    timeoutMs: environment.MISTRAL_TIMEOUT_MS ?? "30000",
    maxRetries: environment.MISTRAL_MAX_RETRIES ?? "2",
  });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]).filter(Boolean))];
    throw new Error(`Mistral configuration is invalid (${fields.join(", ")}).`);
  }
  return parsed.data;
}
