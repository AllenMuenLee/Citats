import { z } from "zod";

export const UI_SCHEMA_VERSION = "1.0" as const;

export const uiIdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const uiTextSchema = z.string().max(500);
export const uiIsoDateTimeSchema = z.string().datetime({ offset: true });

export const uiSourceReferenceSchema = z.object({
  source_id: uiIdentifierSchema,
  title: z.string().min(1).max(200),
  url: z.string().url().max(2048).refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  }),
}).strict();

export const uiProvenanceSchema = z.object({
  invocation_id: uiIdentifierSchema,
  sources: z.array(uiSourceReferenceSchema).min(1).max(30),
}).strict();

export const uiFreshnessSchema = z.object({
  retrieved_at: uiIsoDateTimeSchema,
  stale_after: uiIsoDateTimeSchema.optional(),
}).strict();

export const uiWarningSchema = z.object({
  code: z.enum(["partial_data", "stale_data", "inconsistent_data", "validation_failed"]),
  message: z.string().min(1).max(300),
}).strict();

export const uiCommandDescriptorSchema = z.object({
  command_type: z.enum([
    "product.refresh",
    "product.filter",
    "flight.refresh",
    "flight.filter",
    "flight.detail",
  ]),
  schema_version: z.literal(UI_SCHEMA_VERSION),
}).strict();

export type UiSourceReference = z.infer<typeof uiSourceReferenceSchema>;
export type UiProvenance = z.infer<typeof uiProvenanceSchema>;
export type UiFreshness = z.infer<typeof uiFreshnessSchema>;
export type UiWarning = z.infer<typeof uiWarningSchema>;
export type UiCommandDescriptor = z.infer<typeof uiCommandDescriptorSchema>;
