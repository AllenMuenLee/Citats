import { createModelAdapter, createTextCompletion, readAiConfig, type ModelMetrics, type ModelRoleConfig } from "../../../server/ai";
import { BrowserServiceClient } from "../../../server/browser-service/client";
import { readBrowserServiceConfig } from "../../../server/browser-service/config";
import { InMemoryConversationRepository } from "../../../server/conversation";
import { ChatOrchestrator, compressObservation, createToolRegistry, OrchestratorError, readOrchestratorConfig, type OrchestratorEvent } from "../../../server/orchestrator";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  buildImplementationPlan,
  buildUiGenerationRequest,
  createAdaptiveGeneratedUi,
  createUiGenerationAdapter,
  generatedUiInstances,
} from "../../../server/generative-ui";
import { registerGeneratedUiArtifact } from "../../../server/generative-ui/bridge/artifact-store";
import { GENERATED_UI_TOOLCHAIN_VERSION, validateGeneratedUiSource } from "../../../server/generative-ui/compiler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z.object({
  sessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  text: z.string().trim().min(1).max(32_000),
}).strict();

const conversations = new InMemoryConversationRepository();

const GENERATED_UI_RUNTIME_EXPORTS = [
  "GeneratedViewProps", "Stack", "Inline", "Grid", "Card", "Text", "Heading", "Badge", "List", "ListItem",
  "Table", "TableHead", "TableBody", "TableRow", "TableHeader", "TableCell", "Label", "Select", "Option",
  "Status", "Warning", "Source", "Freshness", "Icon", "Media", "Modal", "CommandButton", "useBoundedState", "useLocalCollection",
  "formatNumber", "formatCurrency", "formatDate",
];

function eventFrame(event: OrchestratorEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

async function createDefaultOrchestrator(): Promise<ChatOrchestrator> {
  const ai = readAiConfig();
  const browserServiceConfig = readBrowserServiceConfig();
  const orchestratorConfig = readOrchestratorConfig();
  const emitMetrics = orchestratorConfig.logTokenUsage
    ? (role: ModelRoleConfig, label: string) => (metrics: ModelMetrics) =>
        console.info(`[ai] usage ${label}`, { provider: role.provider, model: role.model, correlationId: metrics.correlationId, promptTokens: metrics.promptTokens, completionTokens: metrics.completionTokens, durationMs: metrics.durationMs })
    : undefined;
  const adapterFor = (role: ModelRoleConfig, label: string) =>
    createModelAdapter(role, emitMetrics ? { emitMetrics: emitMetrics(role, label) } : {});
  // The extraction model reads one rendered-page observation and returns a
  // closed-schema digest of it. It is never given a local tool, never given a
  // hosted tool, and never answers the user -- see
  // server/orchestrator/observation-digest.ts.
  const extractionAdapter = ai.extraction ? adapterFor(ai.extraction, "extraction") : undefined;
  const browserServiceClient = browserServiceConfig
    ? new BrowserServiceClient({
        baseUrl: browserServiceConfig.baseUrl,
        serviceToken: browserServiceConfig.serviceToken,
      })
    : undefined;
  const uiRole = ai.ui;
  return new ChatOrchestrator({
    model: adapterFor(ai.chat, "chat"),
    conversations,
    ...(extractionAdapter
      ? { compressObservation: (input) => compressObservation(extractionAdapter, input) }
      : {}),
    maxSteps: orchestratorConfig.maxSteps,
    maxEstimatedTokens: orchestratorConfig.maxContextTokens,
    maxRunTokens: orchestratorConfig.maxRunTokens,
    // No deadlineMs: a turn runs until it finishes, hits maxSteps, or the
    // user stops it themselves -- see server/orchestrator/config.ts.
    // The browser service is optional at the chat-endpoint level: when it
    // isn't configured (e.g. local dev without services/browser running),
    // browser.navigate_and_extract is simply omitted rather than failing
    // the whole endpoint.
    tools: createToolRegistry({
      navigateAndExtractExecutor: browserServiceClient,
      phaseThreeExecutor: browserServiceClient,
    }),
    generateUi: uiRole ? async ({ ownerId, task, result, signal }) => {
      const requestId = randomUUID();
      // Two separate models, in order: the extraction model turns the
      // capture plus the user's prompt into a free-form implementation
      // prompt and a validated metadata artifact, and only then does the UI
      // model write React from them. Without EXTRACTION_MODEL the plan
      // degrades to a deterministic one rather than disappearing.
      const brief = await buildImplementationPlan(extractionAdapter, { correlationId: requestId, task, result, signal });
      const pageUnderstanding = result.payload.pageUnderstanding;
      const request = buildUiGenerationRequest({ task, brief, page: pageUnderstanding, requestId, userId: ownerId });
      const adapter = createUiGenerationAdapter({
        model: uiRole.model, compilerVersion: GENERATED_UI_TOOLCHAIN_VERSION,
        maxTokens: uiRole.provider === "groq" ? 3_000 : 16_000, deadlineMs: 90_000,
        runtimeExports: GENERATED_UI_RUNTIME_EXPORTS,
        transport: createTextCompletion(uiRole),
        validate: async (response) => response.tsxSource ? validateGeneratedUiSource({ source: response.tsxSource, manifest: response.manifest, limits: request.limits, allowedTokens: request.theme.allowedTokens }).issues : [],
      });
      const generated = await createAdaptiveGeneratedUi({ generate: adapter.generate, registerArtifact: registerGeneratedUiArtifact, instances: generatedUiInstances }, { ownerId, request, observationDigest: pageUnderstanding.observationDigest, signal });
      return generated.reference;
    } : undefined,
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
            // Safety net for any failure reaching this boundary, not just the
            // model provider's -- the client only ever gets the safe, generic
            // message below, so this is the one place the real cause
            // (including the OrchestratorError code and any provider cause
            // chain) is visible at all.
            console.error("[chat] request failed", error);
            const policyFailure = error instanceof OrchestratorError && ["UNKNOWN_TOOL", "REPEATED_TOOL_CALL", "CONTRACT_ERROR"].includes(error.code);
            controller.enqueue(eventFrame({
              type: "error",
              message: error instanceof Error ? error.message : "The assistant request failed safely.",
              retryable: !policyFailure,
            }));
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
