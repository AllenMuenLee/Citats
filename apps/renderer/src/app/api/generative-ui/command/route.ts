import { z } from "zod";
import { generatedUiInstances } from "@/server/generative-ui/instance-store";

const RequestSchema = z.object({
  instanceId: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
  kind: z.enum(["activate", "select", "set_value", "open_detail", "media_control"]),
  capabilityId: z.string().min(1).max(128),
  arguments: z.record(z.string().max(100), z.unknown()),
}).strict();

export async function POST(request: Request): Promise<Response> {
  try {
    const input = RequestSchema.parse(await request.json());
    generatedUiInstances.validateCommand({ ...input, ownerId: "desktop-local-user" });
    return Response.json({ accepted: true, execution: "deferred_to_phase_5" }, { status: 202 });
  } catch {
    return Response.json({ error: "Generated UI command is invalid, stale, or unavailable." }, { status: 409 });
  }
}
