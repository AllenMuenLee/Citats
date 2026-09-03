import { z } from "zod";

/**
 * The generated-view bridge (P04-F04 step 3).
 *
 * Outbound, the sandbox may send exactly four things: `ready`, `resize`,
 * `focus`, and `telemetry`. There is deliberately **no command channel and
 * no website-command channel** -- a generated view is display-only, so
 * there is nothing for it to ask the host to do.
 *
 * Inbound, the host sends exactly one message: `init`, carrying the
 * display-safe props (trusted request label, trusted source metadata,
 * coverage numbers). Everything else the sandbox needs it already has from
 * its own origin.
 *
 * Every message on both sides carries the full envelope, and the host
 * checks origin, channel, ownership, digests, revision, sequence, rate, and
 * size before acting on any of it.
 */
export const GENERATED_UI_BRIDGE_VERSION = 2 as const;
export const MAX_BRIDGE_MESSAGE_BYTES = 16 * 1024;
export const MAX_INIT_MESSAGE_BYTES = 1_024 * 1_024;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

const envelope = {
  bridgeVersion: z.literal(GENERATED_UI_BRIDGE_VERSION),
  channel: identifier,
  instanceId: identifier,
  artifactId: z.string().regex(/^gui_[a-f0-9]{64}$/),
  implementationPromptDigest: digest,
  inputDigest: digest,
  revision: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
};

/** Messages the sandbox may send to the host. */
export const GeneratedUiMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("ready") }).strict(),
  z.object({ ...envelope, type: z.literal("resize"), height: z.number().int().min(120).max(4_096) }).strict(),
  z.object({ ...envelope, type: z.literal("focus"), direction: z.enum(["forward", "backward", "inside"]) }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal("telemetry"),
      event: z.enum(["rendered", "heartbeat", "render_error", "policy_violation"]),
      code: identifier.nullable(),
    })
    .strict(),
]);

export type GeneratedUiMessage = z.infer<typeof GeneratedUiMessageSchema>;

/** The one message the host sends into the sandbox. */
export interface GeneratedUiInitMessage {
  readonly bridgeVersion: typeof GENERATED_UI_BRIDGE_VERSION;
  readonly type: "init";
  readonly channel: string;
  readonly instanceId: string;
  readonly artifactId: string;
  readonly implementationPromptDigest: string;
  readonly inputDigest: string;
  readonly revision: number;
  readonly props: unknown;
}

/** The ready handshake, as the client reports it back to the trusted server. */
export const GeneratedUiReadyReportSchema = z
  .object({
    instanceId: identifier,
    artifactId: z.string().regex(/^gui_[a-f0-9]{64}$/),
    implementationPromptDigest: digest,
    revision: z.number().int().nonnegative(),
  })
  .strict();

export type GeneratedUiReadyReport = z.infer<typeof GeneratedUiReadyReportSchema>;
