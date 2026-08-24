import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppendMessageInput, type AppendAuthority, type ConversationMessage, type ConversationTurn, ConversationPartSchema, ConversationRoleSchema } from "./types";

const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const AppendSchema = z.object({
  role: ConversationRoleSchema,
  parts: z.array(ConversationPartSchema).min(1).max(64),
  correlationId: IdSchema,
  completeTurn: z.boolean().optional(),
}).strict();

interface SessionState {
  ownerId: string;
  turns: ConversationTurn[];
  nextSequence: number;
  activeRequestId?: string;
  lastTouchedAt: number;
}

export interface ConversationRepository {
  append(sessionId: string, ownerId: string, input: AppendMessageInput, authority: AppendAuthority): ConversationMessage;
  read(sessionId: string, ownerId: string): readonly ConversationTurn[];
  clear(sessionId: string, ownerId: string): void;
  acquireRequest(sessionId: string, ownerId: string, requestId: string): () => void;
  cleanupExpired(): number;
}

export class ConversationStateError extends Error {
  constructor(readonly code: "INVALID_APPEND" | "FORBIDDEN" | "INVALID_SEQUENCE" | "REQUEST_ACTIVE", message: string) {
    super(message);
    this.name = "ConversationStateError";
  }
}

export interface InMemoryConversationRepositoryOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly createId?: () => string;
}

export class InMemoryConversationRepository implements ConversationRepository {
  private readonly sessions = new Map<string, SessionState>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: InMemoryConversationRepositoryOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error("ttlMs must be positive");
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  append(sessionId: string, ownerId: string, input: AppendMessageInput, authority: AppendAuthority): ConversationMessage {
    this.validateIdentity(sessionId, ownerId);
    const parsed = AppendSchema.safeParse(input);
    if (!parsed.success) throw new ConversationStateError("INVALID_APPEND", "Conversation message is invalid");
    if (authority === "client" && (parsed.data.role !== "user" || parsed.data.parts.some((part) => part.type !== "text" || part.trust !== "trusted-user"))) {
      throw new ConversationStateError("FORBIDDEN", "Clients may append only trusted-user text messages");
    }

    const session = this.getOrCreate(sessionId, ownerId);
    const lastTurn = session.turns.at(-1);
    let turn: ConversationTurn;
    if (parsed.data.role === "user") {
      if (lastTurn && !lastTurn.complete) throw new ConversationStateError("INVALID_SEQUENCE", "The current turn is not complete");
      turn = { id: this.createId(), correlationId: parsed.data.correlationId, complete: false, messages: [] };
      session.turns.push(turn);
    } else {
      if (!lastTurn || lastTurn.complete) throw new ConversationStateError("INVALID_SEQUENCE", "A server response requires an active user turn");
      if (lastTurn.correlationId !== parsed.data.correlationId) throw new ConversationStateError("INVALID_SEQUENCE", "Correlation ID does not match the active turn");
      if (parsed.data.role === "tool" && parsed.data.parts.some((part) => part.type !== "tool-result")) throw new ConversationStateError("INVALID_APPEND", "Tool messages require tool-result parts");
      turn = lastTurn;
    }

    const message: ConversationMessage = Object.freeze({ id: this.createId(), turnId: turn.id, correlationId: parsed.data.correlationId, role: parsed.data.role, parts: Object.freeze(parsed.data.parts), sequence: session.nextSequence++, createdAt: this.now() });
    const updated = { ...turn, complete: parsed.data.role === "assistant" && parsed.data.completeTurn === true, messages: Object.freeze([...turn.messages, message]) };
    session.turns[session.turns.length - 1] = updated;
    session.lastTouchedAt = this.now();
    return message;
  }

  read(sessionId: string, ownerId: string): readonly ConversationTurn[] {
    this.validateIdentity(sessionId, ownerId);
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    this.assertOwner(session, ownerId);
    session.lastTouchedAt = this.now();
    return session.turns.map((turn) => ({ ...turn, messages: [...turn.messages] }));
  }

  clear(sessionId: string, ownerId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.assertOwner(session, ownerId);
    this.sessions.delete(sessionId);
  }

  acquireRequest(sessionId: string, ownerId: string, requestId: string): () => void {
    this.validateIdentity(sessionId, ownerId);
    if (!IdSchema.safeParse(requestId).success) throw new ConversationStateError("INVALID_APPEND", "Request ID is invalid");
    const session = this.getOrCreate(sessionId, ownerId);
    if (session.activeRequestId) throw new ConversationStateError("REQUEST_ACTIVE", "A request is already active for this session");
    session.activeRequestId = requestId;
    session.lastTouchedAt = this.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.sessions.get(sessionId);
      if (current?.activeRequestId === requestId) {
        current.activeRequestId = undefined;
        current.lastTouchedAt = this.now();
      }
    };
  }

  cleanupExpired(): number {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;
    for (const [sessionId, session] of this.sessions) {
      if (!session.activeRequestId && session.lastTouchedAt <= cutoff) {
        this.sessions.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  private getOrCreate(sessionId: string, ownerId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.assertOwner(existing, ownerId);
      return existing;
    }
    const created = { ownerId, turns: [], nextSequence: 0, lastTouchedAt: this.now() };
    this.sessions.set(sessionId, created);
    return created;
  }

  private validateIdentity(sessionId: string, ownerId: string): void {
    if (!IdSchema.safeParse(sessionId).success || !IdSchema.safeParse(ownerId).success) throw new ConversationStateError("INVALID_APPEND", "Session identity is invalid");
  }

  private assertOwner(session: SessionState, ownerId: string): void {
    if (session.ownerId !== ownerId) throw new ConversationStateError("FORBIDDEN", "Session belongs to a different owner");
  }
}

