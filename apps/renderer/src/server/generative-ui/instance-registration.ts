import type { GenerativeUiPart } from "../../../../../packages/contracts/src/ui/generative-ui";
import type { UiCommandType } from "../../../../../packages/contracts/src/ui/ui-command";
import { commandMappingsFor } from "./command-mappings";
import { digestUiResult, type InMemoryUiInstanceStore } from "./instance-store";

export function registerGenerativeUiInstance(
  store: InMemoryUiInstanceStore,
  part: GenerativeUiPart,
  identity: { sessionId: string; ownerId: string },
): GenerativeUiPart {
  const commandTypes = part.allowed_commands.map((descriptor) => descriptor.command_type) as UiCommandType[];
  const expectedPrefix = part.component_type === "product_results" ? "product." : "flight.";
  if (commandTypes.some((type) => !type.startsWith(expectedPrefix))) throw new TypeError("A component declared a command outside its fixed allowlist.");
  const { component_instance_id: _ignoredInstanceId, ...digestibleProps } = part.props;
  const resultDigest = digestUiResult(digestibleProps);
  const instanceId = store.create({
    ownerId: identity.ownerId,
    sessionId: identity.sessionId,
    componentType: part.component_type,
    schemaVersion: part.schema_version,
    resultDigest,
    commands: commandMappingsFor(commandTypes),
    provenance: part.provenance,
  });
  return { ...part, instance_id: instanceId, result_digest: resultDigest, props: { ...part.props, component_instance_id: instanceId } } as GenerativeUiPart;
}
