import { z } from "zod";
import {
  createModelAdapter,
  createTranscriptLogger,
  readAiConfig,
  withTranscriptLog,
  type ModelMetrics,
  type ModelRoleConfig,
} from "../../../server/ai";
import { InMemoryConversationRepository } from "../../../server/conversation";
import {
  ChatOrchestrator,
  createToolRegistry,
  OrchestratorError,
  readOrchestratorConfig,
  type OrchestratorEvent,
} from "../../../server/orchestrator";
import { createUiGenerateFromConfig } from "../../../server/ui-generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z
  .object({
    sessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    text: z.string().trim().min(1).max(32_000),
  })
  .strict();

const conversations = new InMemoryConversationRepository();

function eventFrame(event: OrchestratorEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

async function createDefaultOrchestrator(): Promise<ChatOrchestrator> {
  const ai = readAiConfig();
  const orchestratorConfig = readOrchestratorConfig();
  const emitMetrics = orchestratorConfig.logTokenUsage
    ? (role: ModelRoleConfig, label: string) => (metrics: ModelMetrics) =>
        console.info(`[ai] usage ${label}`, {
          provider: role.provider,
          model: role.model,
          correlationId: metrics.correlationId,
          promptTokens: metrics.promptTokens,
          completionTokens: metrics.completionTokens,
          durationMs: metrics.durationMs,
        })
    : undefined;
  // Opt-in, developer-only. `CHAT_LOG_CONVERSATION=1` writes every model
  // request and response to one JSONL file, which is what makes "the model
  // stopped calling the tool" diagnosable.
  const transcript = createTranscriptLogger();
  const chatAdapter = withTranscriptLog(
    createModelAdapter(ai.chat, emitMetrics ? { emitMetrics: emitMetrics(ai.chat, "chat") } : {}),
    "chat",
    transcript,
  );

  // The three internal `ui.generate` stages. All three must be configured;
  // otherwise the tool is not offered at all rather than being offered and
  // failing every call.
  const uiGenerate = createUiGenerateFromConfig({ ai });
  if (!uiGenerate) {
    console.warn(
      "[chat] ui.generate is disabled: SOURCE_FINDING_MODEL, UI_PLANNING_MODEL and UI_MODEL (with their *_MODEL_PROVIDER"
        + " variables) must all be set. The assistant will answer in text only.",
    );
  }

  return new ChatOrchestrator({
    model: chatAdapter,
    conversations,
    ...(transcript.enabled
      ? {
          trace: (event: string, detail: Record<string, unknown>) =>
            transcript.record({ kind: "orchestrator", correlationId: String(detail.requestId ?? ""), event, detail }),
        }
      : {}),
    maxSteps: orchestratorConfig.maxSteps,
    maxEstimatedTokens: orchestratorConfig.maxContextTokens,
    // No deadlineMs: a turn runs until it finishes, hits maxSteps, or the
    // user stops it themselves -- see server/orchestrator/config.ts.
    tools: createToolRegistry(uiGenerate ? { uiGenerate } : {}),
  });
}

export function createChatPost(orchestrator: ChatOrchestrator) {
  return async function POST(request: Request): Promise<Response> {
    let input: z.infer<typeof RequestSchema>;
    try {
      input = RequestSchema.parse(await request.json());
    } catch {
      return Response.json({ error: "Chat request is invalid." }, { status: 400 });
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of orchestrator.run({
            sessionId: input.sessionId,
            ownerId: "desktop-local-user",
            text: input.text,
            signal: request.signal,
          })) {
            controller.enqueue(eventFrame(event));
          }
        } catch (error) {
          if (!request.signal.aborted) {
            // The client only ever gets the safe, generic message below, so
            // this is the one place the real cause is visible at all.
            console.error("[chat] request failed", error);
            const policyFailure =
              error instanceof OrchestratorError && ["UNKNOWN_TOOL", "REPEATED_TOOL_CALL", "CONTRACT_ERROR"].includes(error.code);
            controller.enqueue(
              eventFrame({
                type: "error",
                message: error instanceof Error ? error.message : "The assistant request failed safely.",
                retryable: !policyFailure,
              }),
            );
          }
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await createChatPost(await createDefaultOrchestrator())(request);
  } catch (error) {
    console.error("[chat] the local AI service is not configured", error);
    return Response.json({ error: "The local AI service is not configured." }, { status: 503 });
  }
}
