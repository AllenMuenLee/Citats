import { z } from "zod";

export const MAX_PART_LENGTH = 32_000;

export const TrustLabelSchema = z.enum(["trusted-user", "trusted-server", "untrusted-tool"]);
export type TrustLabel = z.infer<typeof TrustLabelSchema>;

export const ConversationPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(MAX_PART_LENGTH), trust: TrustLabelSchema }).strict(),
  z.object({ type: z.literal("tool-call"), toolName: z.string().min(1).max(128), invocationId: z.string().min(1).max(128), arguments: z.unknown(), trust: z.literal("trusted-server") }).strict(),
  z.object({ type: z.literal("tool-result"), toolName: z.string().min(1).max(128), invocationId: z.string().min(1).max(128), result: z.unknown(), trust: z.literal("untrusted-tool") }).strict(),
]);
export type ConversationPart = z.infer<typeof ConversationPartSchema>;

export const ConversationRoleSchema = z.enum(["user", "assistant", "tool"]);
export type ConversationRole = z.infer<typeof ConversationRoleSchema>;

export interface ConversationMessage {
  readonly id: string;
  readonly turnId: string;
  readonly correlationId: string;
  readonly role: ConversationRole;
  readonly parts: readonly ConversationPart[];
  readonly sequence: number;
  readonly createdAt: number;
}

export interface ConversationTurn {
  readonly id: string;
  readonly correlationId: string;
  readonly complete: boolean;
  readonly messages: readonly ConversationMessage[];
}

export interface AppendMessageInput {
  readonly role: ConversationRole;
  readonly parts: readonly ConversationPart[];
  readonly correlationId: string;
  readonly completeTurn?: boolean;
}

export type AppendAuthority = "client" | "server";

