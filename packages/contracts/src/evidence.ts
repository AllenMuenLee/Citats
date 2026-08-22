import { z } from "zod";
import { HttpUrlSchema, IsoDateTimeSchema } from "./primitives";

export const EVIDENCE_TITLE_MAX_LENGTH = 300;
export const EVIDENCE_SNIPPET_MAX_LENGTH = 2000;
export const MAX_EVIDENCE_ITEMS = 20;

/**
 * A single citation/evidence item attached to a tool result: where the
 * information came from, so a downstream consumer (the model, the UI) can
 * show a source rather than an unverifiable claim.
 */
export const EvidenceItemSchema = z
  .object({
    sourceUrl: HttpUrlSchema,
    title: z.string().trim().min(1).max(EVIDENCE_TITLE_MAX_LENGTH),
    snippet: z.string().max(EVIDENCE_SNIPPET_MAX_LENGTH),
    retrievedAt: IsoDateTimeSchema,
  })
  .strict();

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const EvidenceListSchema = z.array(EvidenceItemSchema).max(MAX_EVIDENCE_ITEMS);
