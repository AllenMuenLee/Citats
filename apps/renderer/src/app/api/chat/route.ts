import { createMistralConversationsAdapter, readMistralConfig } from "../../../server/ai/mistral";
import { BrowserServiceClient } from "../../../server/browser-service/client";
import { readBrowserServiceConfig } from "../../../server/browser-service/config";
import { InMemoryConversationRepository } from "../../../server/conversation";
import { ChatOrchestrator, createToolRegistry, OrchestratorError, type OrchestratorEvent } from "../../../server/orchestrator";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  buildUiGenerationRequest,
  createAdaptiveGeneratedUi,
  createMistralUiGenerationAdapter,
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

function eventFrame(event: OrchestratorEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

async function createDefaultOrchestrator(): Promise<ChatOrchestrator> {
  const mistralConfig = readMistralConfig();
  const browserServiceConfig = readBrowserServiceConfig();
  const browserServiceClient = browserServiceConfig
    ? new BrowserServiceClient({
        baseUrl: browserServiceConfig.baseUrl,
        serviceToken: browserServiceConfig.serviceToken,
      })
    : undefined;
  return new ChatOrchestrator({
    model: createMistralConversationsAdapter(mistralConfig),
    conversations,
    // The browser service is optional at the chat-endpoint level: when it
    // isn't configured (e.g. local dev without services/browser running),
    // browser.navigate_and_extract is simply omitted rather than failing
    // the whole endpoint.
    tools: createToolRegistry({
      navigateAndExtractExecutor: browserServiceClient,
      phaseThreeExecutor: browserServiceClient,
    }),
    generateUi: process.env.MISTRAL_UI_MODEL ? async ({ ownerId, task, plan, pageUnderstanding, signal }) => {
      const request = buildUiGenerationRequest({ task, plan, page: pageUnderstanding, requestId: randomUUID(), userId: ownerId });
      const adapter = createMistralUiGenerationAdapter({
        model: process.env.MISTRAL_UI_MODEL!, compilerVersion: GENERATED_UI_TOOLCHAIN_VERSION,
        maxTokens: 16_000, deadlineMs: 45_000,
        runtimeExports: ["GeneratedViewProps", "Stack", "Inline", "Grid", "Card", "Text", "Heading", "Badge", "List", "ListItem", "Table", "TableHead", "TableBody", "TableRow", "TableHeader", "TableCell", "Label", "Select", "Option", "Status", "Warning", "Source", "Freshness", "Icon", "Media", "Modal", "CommandButton", "useBoundedState", "formatNumber", "formatCurrency", "formatDate"],
        transport: async (uiRequest, transportSignal) => {
          const response = await fetch(new URL("chat/completions", mistralConfig.baseUrl), {
            method: "POST", signal: transportSignal,
            headers: { authorization: `Bearer ${mistralConfig.apiKey}`, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ model: uiRequest.model, temperature: uiRequest.temperature, max_tokens: uiRequest.maxTokens, messages: uiRequest.messages, tools: uiRequest.tools, tool_choice: uiRequest.toolChoice, response_format: { type: uiRequest.responseFormat.type, json_schema: uiRequest.responseFormat.jsonSchema } }),
          });
          if (!response.ok) throw new Error("UI generation provider unavailable");
          const body = z.object({ model: z.string(), choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }).parse(await response.json());
          return { model: body.model, content: body.choices[0]!.message.content };
        },
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
  } catch {
    return Response.json({ error: "The local AI service is not configured." }, { status: 503 });
  }
}
