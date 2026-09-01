import { z } from "zod";
import { generatedUiInstances } from "@/server/generative-ui/instance-store";

const RequestSchema = z.object({
  instanceId: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
  kind: z.enum(["activate", "select", "set_value", "open_detail", "media_control"]),
  capabilityId: z.string().min(1).max(128),
  promptTemplateId: z.string().min(1).max(128),
  arguments: z.record(z.string().max(100), z.unknown()),
}).strict();

/**
 * The trusted same-origin command handler (P04-F05 step 3).
 *
 * A generated component can only ever say *which* opaque capability and
 * prompt template it means, plus bounded non-secret arguments. This
 * endpoint revalidates all of that against server-held instance state and
 * reconstructs the AI action prompt from the capability's own validated
 * template -- it never accepts a prompt, the component's full UI state,
 * raw payment data, credentials, cookies, or a selector.
 *
 * The reconstructed prompt is handed to the later action/confirmation flow.
 * Actual Nodriver execution remains Phase 5 authority, so nothing here runs
 * against the real website.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const input = RequestSchema.parse(await request.json());
    const { action } = generatedUiInstances.validateCommand({ ...input, ownerId: "desktop-local-user" });
    return Response.json({
      accepted: true,
      execution: action.requiresConfirmation ? "awaiting_user_confirmation" : "deferred_to_phase_5",
      action: {
        capabilityId: action.capabilityId,
        promptTemplateId: action.promptTemplateId,
        prompt: action.prompt,
        requiresConfirmation: action.requiresConfirmation,
        confirmationFields: action.confirmationFields,
        destinationOrigin: action.destinationOrigin,
        // The handle only, never anything it stands for.
        paymentProfileHandle: action.paymentProfileHandle,
      },
    }, { status: 202 });
  } catch {
    return Response.json({ error: "Generated UI command is invalid, stale, or unavailable." }, { status: 409 });
  }
}
