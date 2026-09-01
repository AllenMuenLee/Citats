import { z } from "zod";

export const GENERATED_UI_BRIDGE_VERSION = 1 as const;
export const MAX_BRIDGE_MESSAGE_BYTES = 16 * 1024;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const envelope = {
  bridgeVersion: z.literal(GENERATED_UI_BRIDGE_VERSION),
  channel: identifier,
  instanceId: identifier,
  artifactId: z.string().regex(/^gui_[a-f0-9]{64}$/),
  inputDigest: digest,
  observationDigest: digest,
  revision: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
};

const safeValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(2_000),
  z.array(safeValue).max(64), z.record(z.string().max(100), safeValue),
]));

export const UiCommandMessageSchema = z.object({
  ...envelope,
  type: z.literal("command"),
  command: z.object({
    kind: z.enum(["activate", "select", "set_value", "open_detail", "media_control"]),
    capabilityId: identifier,
    /**
     * The Phase 3 prompt-template this command resolves to. The generated
     * component can reference it but never read or author it -- the trusted
     * server rebuilds the AI action prompt from its own copy.
     */
    promptTemplateId: identifier,
    arguments: z.record(z.string().max(100), safeValue),
  }).strict(),
}).strict();

export const GeneratedUiMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("ready") }).strict(),
  z.object({ ...envelope, type: z.literal("resize"), height: z.number().int().min(120).max(4_096) }).strict(),
  z.object({ ...envelope, type: z.literal("focus"), direction: z.enum(["forward", "backward", "inside"]) }).strict(),
  z.object({ ...envelope, type: z.literal("telemetry"), event: z.enum(["rendered", "heartbeat", "render_error", "policy_violation"]), code: identifier.nullable() }).strict(),
  UiCommandMessageSchema,
]);

export type GeneratedUiMessage = z.infer<typeof GeneratedUiMessageSchema>;
export type UiCommandMessage = z.infer<typeof UiCommandMessageSchema>;
