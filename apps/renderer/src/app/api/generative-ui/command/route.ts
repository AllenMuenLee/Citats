import type { UiCommandResult } from "../../../../../../../packages/contracts/src/ui/ui-command";
import { UiCommandHandler, type ReadOnlyExecutors } from "../../../../server/generative-ui/command-handler";
import { uiCommandInstanceStore } from "../../../../server/generative-ui/instance-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface CommandIdentity { sessionId: string; ownerId: string }
export type CommandAuthenticator = (request: Request) => Promise<CommandIdentity | undefined> | CommandIdentity | undefined;

function typedFailure(code: Extract<UiCommandResult, { ok: false }>["code"], message: string, refreshRequired = false): UiCommandResult {
  return { ok: false, code, message, refresh_required: refreshRequired };
}

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function passesSameOriginAndCsrf(request: Request): boolean {
  const origin = request.headers.get("origin");
  const csrfHeader = request.headers.get("x-csrf-token");
  const csrfCookie = cookie(request, "ai_browser_csrf");
  return origin !== null && origin === new URL(request.url).origin && csrfHeader !== null && csrfHeader.length >= 16 && csrfHeader.length <= 128 && csrfHeader === csrfCookie;
}

export function createUiCommandPost(handler: UiCommandHandler, authenticate: CommandAuthenticator) {
  return async function POST(request: Request): Promise<Response> {
    if (!passesSameOriginAndCsrf(request)) return Response.json(typedFailure("csrf_failed", "The command failed origin or CSRF validation."), { status: 403 });
    const identity = await authenticate(request);
    if (!identity) return Response.json(typedFailure("unauthenticated", "A valid desktop session is required."), { status: 401 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(typedFailure("invalid_command", "The request body is not valid JSON."), { status: 400 });
    }
    try {
      const result = await handler.execute(body, identity);
      const status = result.ok ? 200 : result.code === "rate_limited" ? 429 : result.code === "forbidden" ? 403 : 400;
      return Response.json(result, { status, headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json(typedFailure("invalid_command", "The read-only command could not be completed safely."), { status: 503 });
    }
  };
}

const unavailable: ReadOnlyExecutors = {
  "products.search": async () => { throw new Error("Product search executor is unavailable"); },
  "flights.search": async () => { throw new Error("Flight search executor is unavailable"); },
  "flights.detail": async () => { throw new Error("Flight detail executor is unavailable"); },
};
const defaultHandler = new UiCommandHandler(uiCommandInstanceStore, unavailable);

export const POST = createUiCommandPost(defaultHandler, (request) => {
  const sessionId = request.headers.get("x-ai-browser-session-id");
  if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) return undefined;
  return { sessionId, ownerId: "desktop-local-user" };
});
