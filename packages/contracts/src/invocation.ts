import { z } from "zod";
import { CorrelationMetadataSchema } from "./correlation";
import { IdSchema } from "./primitives";
import { withCredentialGuard } from "./security/credential-guard";
import { CONTRACT_MAJOR_VERSION } from "./version";
import { SYSTEM_ECHO_TOOL_NAME, SystemEchoArgsSchema } from "./tools/system-echo";
import {
  NAVIGATE_AND_EXTRACT_TOOL_NAME,
  NavigateAndExtractArgsSchema,
} from "./tools/navigate-and-extract";

/**
 * Generic factory for a tool invocation envelope: correlation metadata,
 * the tool being called, and its arguments -- with the recursive
 * credential-field guard applied to the arguments payload regardless of
 * what that specific tool's argument schema declares.
 */
export function makeToolInvocationSchema<ToolName extends string, Args extends z.ZodTypeAny>(
  toolName: ToolName,
  argsSchema: Args,
) {
  return withCredentialGuard(
    z
      .object({
        contractVersion: z.literal(CONTRACT_MAJOR_VERSION),
        correlation: CorrelationMetadataSchema,
        toolCallId: IdSchema,
        toolName: z.literal(toolName),
        arguments: argsSchema,
      })
      .strict(),
    (value) => (value as { arguments: unknown }).arguments,
    "arguments",
  );
}

/** Concrete invocation envelope for the `system.echo` reference tool. */
export const SystemEchoInvocationSchema = makeToolInvocationSchema(
  SYSTEM_ECHO_TOOL_NAME,
  SystemEchoArgsSchema,
);

export type SystemEchoInvocation = z.infer<typeof SystemEchoInvocationSchema>;

/** Concrete invocation envelope for the `browser.navigate_and_extract` tool. */
export const NavigateAndExtractInvocationSchema = makeToolInvocationSchema(
  NAVIGATE_AND_EXTRACT_TOOL_NAME,
  NavigateAndExtractArgsSchema,
);

export type NavigateAndExtractInvocation = z.infer<typeof NavigateAndExtractInvocationSchema>;
