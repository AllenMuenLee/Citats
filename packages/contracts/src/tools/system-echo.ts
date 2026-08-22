import { z } from "zod";
import { CredentialHandleSchema } from "../primitives";
import { ToolDefinitionSchema } from "../tool-definition";

/**
 * `system.echo` -- the reference tool used to drive the fixtures/tests in
 * this package and, per `docs/features/p00-f03-tool-contract.md`, the
 * first real consumer of this contract in P00-F04's orchestrator <->
 * browser-service bridge harness. It intentionally exercises every
 * interesting shape (a bounded scalar field, an open metadata bag that the
 * credential guard must reach into, and an optional credential handle) so
 * it can stand in for "some real tool" without pulling in browsing logic.
 */
export const SYSTEM_ECHO_TOOL_NAME = "system.echo" as const;

export const SYSTEM_ECHO_MESSAGE_MAX_LENGTH = 2000;
export const SYSTEM_ECHO_CONTEXT_MAX_KEYS = 20;

export const SystemEchoArgsSchema = z
  .object({
    message: z.string().min(1).max(SYSTEM_ECHO_MESSAGE_MAX_LENGTH),
    /**
     * Open metadata bag for small amounts of caller-supplied context. This
     * is the field the recursive credential guard exists for: it is not a
     * closed shape, so nothing here stops a caller from nesting a
     * `cookie`/`authorization` key several levels deep unless the guard is
     * applied on top (see `invocation.ts`).
     */
    context: z
      .record(z.string(), z.unknown())
      .refine((obj) => Object.keys(obj).length <= SYSTEM_ECHO_CONTEXT_MAX_KEYS, {
        message: `context may have at most ${SYSTEM_ECHO_CONTEXT_MAX_KEYS} keys`,
      })
      .optional(),
    /** Only legal way to reference a credential -- never a raw value. */
    credentialHandle: CredentialHandleSchema.optional(),
  })
  .strict();

export type SystemEchoArgs = z.infer<typeof SystemEchoArgsSchema>;

export const SystemEchoResultSchema = z
  .object({
    message: z.string().max(SYSTEM_ECHO_MESSAGE_MAX_LENGTH),
  })
  .strict();

export type SystemEchoResult = z.infer<typeof SystemEchoResultSchema>;

export const SystemEchoToolDefinition = ToolDefinitionSchema.parse({
  contractVersion: 1,
  name: SYSTEM_ECHO_TOOL_NAME,
  description: "Echoes back the provided message. Reference tool for contract wiring/tests.",
  argsSchemaVersion: 1,
  argsSchemaRef: "system.echo.v1",
  sensitiveByDefault: false,
});
