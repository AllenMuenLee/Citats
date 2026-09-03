import { NextResponse } from "next/server";
import { generatedUiInstances } from "@/server/generative-ui/instance-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves the display-safe props for one mounted instance (P04-F04 step 2).
 *
 * They are kept off the chat stream and behind an owner check: the pane
 * fetches them by instance id and forwards them into the sandbox as the one
 * inbound `init` message. Nothing here carries the implementation prompt,
 * the captured HTML, or the generated source -- only the trusted request
 * label, the trusted source metadata, and bounded coverage numbers.
 */
export async function GET(_request: Request, context: { params: Promise<{ instanceId: string }> }): Promise<NextResponse> {
  const { instanceId } = await context.params;
  const instance = generatedUiInstances.get(instanceId, "desktop-local-user");
  if (!instance) return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  return NextResponse.json(
    {
      instanceId: instance.instanceId,
      artifactId: instance.artifact.artifactId,
      implementationPromptDigest: instance.implementationPromptDigest,
      inputDigest: instance.inputDigest,
      revision: instance.revision,
      expiresAt: instance.artifact.expiresAt,
      displayProps: instance.displayProps,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
