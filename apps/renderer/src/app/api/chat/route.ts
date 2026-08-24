import { createMistralConversationsAdapter, readMistralConfig } from "../../../server/ai/mistral";
import { BrowserServiceClient } from "../../../server/browser-service/client";
import { readBrowserServiceConfig } from "../../../server/browser-service/config";
import { InMemoryConversationRepository } from "../../../server/conversation";
import { ChatOrchestrator, createToolRegistry, OrchestratorError, type OrchestratorEvent } from "../../../server/orchestrator";
import { z } from "zod";

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

function createDefaultOrchestrator(): ChatOrchestrator {
  const browserServiceConfig = readBrowserServiceConfig();
  const browserServiceClient = browserServiceConfig
    ? new BrowserServiceClient({
        baseUrl: browserServiceConfig.baseUrl,
        serviceToken: browserServiceConfig.serviceToken,
      })
    : undefined;
  return new ChatOrchestrator({
    model: createMistralConversationsAdapter(readMistralConfig()),
    conversations,
    // The browser service is optional at the chat-endpoint level: when it
    // isn't configured (e.g. local dev without services/browser running),
    // browser.navigate_and_extract is simply omitted rather than failing
    // the whole endpoint.
    tools: createToolRegistry({ navigateAndExtractExecutor: browserServiceClient }),
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
          })) controller.enqueue(eventFrame(event));
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
    return await createChatPost(createDefaultOrchestrator())(request);
  } catch {
    return Response.json({ error: "The local AI service is not configured." }, { status: 503 });
  }
}
