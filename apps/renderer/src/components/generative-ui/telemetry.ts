export type GenerativeUiMetric = {
  componentType: "product_results" | "flight_comparison";
  schemaVersion: "1.0";
  event: "render_success" | "render_fallback" | "command";
  commandType?: "product.refresh" | "product.filter" | "flight.refresh" | "flight.filter" | "flight.detail";
  latencyMs?: number;
  fallbackReason?: "invalid_schema" | "unknown_component" | "render_error" | "command_error";
  clarity?: "clearer" | "same" | "less_clear";
};

export function recordGenerativeUiMetric(metric: GenerativeUiMetric): void {
  window.dispatchEvent(new CustomEvent("ai-browser:generative-ui-metric", { detail: metric }));
}
