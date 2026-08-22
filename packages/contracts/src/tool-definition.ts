import { z } from "zod";
import { CONTRACT_MAJOR_VERSION } from "./version";

export const TOOL_NAME_MAX_LENGTH = 64;
export const TOOL_DESCRIPTION_MAX_LENGTH = 500;
export const ARGS_SCHEMA_REF_MAX_LENGTH = 200;

/**
 * Tool names are a closed dotted-namespace format (`namespace.tool_name`),
 * lowercase, so they can be used directly as Mistral tool-calling function
 * names and as REST/log identifiers without further encoding.
 */
export const ToolNameSchema = z
  .string()
  .min(3)
  .max(TOOL_NAME_MAX_LENGTH)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    "must be a lowercase dotted name, e.g. 'system.echo'",
  );

/**
 * Describes a tool available for Mistral to call: its name, a
 * human/model-readable description, which version of its own argument
 * schema it implements, a reference to that schema, and whether it is
 * sensitive by default (see `sensitivity.ts`). This is metadata *about* a
 * tool, not an invocation of one -- see `invocation.ts`.
 */
export const ToolDefinitionSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_MAJOR_VERSION),
    name: ToolNameSchema,
    description: z.string().trim().min(1).max(TOOL_DESCRIPTION_MAX_LENGTH),
    /**
     * Version of this specific tool's *argument* schema (independent of
     * `contractVersion`, which versions the envelope shapes this whole
     * package defines). Bump per-tool when that tool's argument shape
     * changes in a backward-incompatible way.
     */
    argsSchemaVersion: z.number().int().positive().max(1000),
    /** Opaque reference/name for the argument schema this definition points at, e.g. `"system.echo.v1"`. */
    argsSchemaRef: z.string().min(1).max(ARGS_SCHEMA_REF_MAX_LENGTH),
    sensitiveByDefault: z.boolean(),
  })
  .strict();

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
