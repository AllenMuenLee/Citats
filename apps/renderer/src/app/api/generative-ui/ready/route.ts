import { NextResponse } from "next/server";
import { GeneratedUiReadyReportSchema } from "@/server/generative-ui/bridge/protocol";
import { generatedUiInstances } from "@/server/generative-ui/instance-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The trusted end of the ready handshake (P04-F04 step 4).
 *
 * The renderer forwards a sandbox `ready` message here only after it has
 * validated the message's origin, channel, ownership, digests, revision and
 * sequence. The instance store then re-checks artifact, plan digest, and
 * revision against its own state, so a forged or stale report resolves
 * nothing and `ui.generate` still fails with `render_failed`.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let report: unknown;
  try {
    report = GeneratedUiReadyReportSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ ready: false }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const parsed = report as ReturnType<typeof GeneratedUiReadyReportSchema.parse>;
  const ready = generatedUiInstances.markReady({ ...parsed, ownerId: "desktop-local-user" });
  return NextResponse.json({ ready }, { status: ready ? 200 : 409, headers: { "cache-control": "no-store" } });
}
