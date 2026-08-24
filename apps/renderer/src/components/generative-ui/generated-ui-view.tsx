"use client";

import { useEffect, useState } from "react";
import type { GenerativeUiPart, UiCommand, UiCommandResult } from "@ai-browser/contracts";
import { FlightComparison, type FlightDetailCommand } from "./flight-comparison";
import { ProductResults } from "./product-results";
import type { ProductCommand } from "../../../../../packages/contracts/src/ui/product-result";
import { GenerativeUiErrorBoundary } from "./error-boundary";
import { recordGenerativeUiMetric } from "./telemetry";

function csrfToken(): string | undefined {
  return document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("ai_browser_csrf="))?.slice("ai_browser_csrf=".length);
}

export function GeneratedUiView({ part, sessionId }: { part: GenerativeUiPart; sessionId: string }) {
  const [commandState, setCommandState] = useState<"idle" | "running" | "error">("idle");
  const [commandMessage, setCommandMessage] = useState("");

  useEffect(() => {
    recordGenerativeUiMetric({ componentType: part.component_type, schemaVersion: part.schema_version, event: "render_success" });
  }, [part.component_type, part.schema_version]);

  async function send(command: UiCommand) {
    const started = performance.now();
    setCommandState("running");
    setCommandMessage("Refreshing generated results...");
    try {
      const csrf = csrfToken();
      const response = await fetch("/api/generative-ui/command", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ai-browser-session-id": sessionId,
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        body: JSON.stringify(command),
      });
      const result = await response.json() as UiCommandResult;
      if (!result.ok) throw new Error(result.message);
      setCommandState("idle");
      setCommandMessage(result.relationship === "replace" ? "Updated results received." : "Additional details received.");
      recordGenerativeUiMetric({ componentType: part.component_type, schemaVersion: part.schema_version, event: "command", commandType: command.command_type, latencyMs: Math.round(performance.now() - started) });
    } catch (error) {
      setCommandState("error");
      setCommandMessage(error instanceof Error ? error.message : "The read-only command failed. Refresh the conversation safely.");
      recordGenerativeUiMetric({ componentType: part.component_type, schemaVersion: part.schema_version, event: "render_fallback", fallbackReason: "command_error" });
    }
  }

  const envelope = {
    schema_version: part.schema_version,
    component_instance_id: part.instance_id,
    originating_result_digest: part.result_digest,
    correlation_id: part.correlation_id,
  } as const;
  const productCommand = (command: ProductCommand) => {
    if (command.command_type === "product.refresh") {
      void send({ ...envelope, component_type: "product_results", command_type: "product.refresh", arguments: { query: command.query_state.query } });
    } else {
      void send({ ...envelope, component_type: "product_results", command_type: "product.filter", arguments: { query: command.query_state.query, ...(command.query_state.filter ? { merchant: command.query_state.filter } : {}) } });
    }
  };
  const flightCommand = (command: FlightDetailCommand) => void send({
    ...envelope,
    component_type: "flight_comparison",
    command_type: "flight.detail",
    arguments: command.arguments,
  });
  const productCommandsEnabled = part.allowed_commands.some((command) => command.command_type.startsWith("product."));
  const flightCommandsEnabled = part.allowed_commands.some((command) => command.command_type === "flight.detail");

  return <GenerativeUiErrorBoundary fallbackText={part.fallback_text} onError={() => recordGenerativeUiMetric({ componentType: part.component_type, schemaVersion: part.schema_version, event: "render_fallback", fallbackReason: "render_error" })}>
    {part.component_type === "product_results"
      ? <ProductResults {...part.props} state={commandState === "running" ? "loading" : commandState === "error" ? "error" : "ready"} error_message={commandMessage} onCommand={productCommandsEnabled ? productCommand : undefined} />
      : <FlightComparison {...part.props} component_instance_id={part.instance_id} loading={commandState === "running"} error={commandState === "error" ? commandMessage : undefined} onCommand={flightCommandsEnabled ? flightCommand : undefined} />}
    {commandMessage && commandState !== "error" ? <p role="status">{commandMessage}</p> : null}
  </GenerativeUiErrorBoundary>;
}
