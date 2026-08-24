import { describe, expect, it } from "vitest";
import { validateGenerativeUiPart } from "../../src/server/generative-ui/registry";

const baseProductPart = {
  component_type: "product_results",
  schema_version: "1.0",
  instance_id: "instance-1",
  result_digest: "a".repeat(64),
  props: {
    component_instance_id: "instance-1",
    query: "headphones",
    items: [{
      id: "product-1",
      name: "Quiet headphones",
      price: { amount: "199.00", currency: "USD" },
      merchant: "Example merchant",
      availability: "In stock",
      attributes: [],
      source_ids: ["source-1"],
      partial_data_warnings: [],
    }],
    sources: [{ source_id: "source-1", title: "Example source", url: "https://example.test/product" }],
    freshness: { retrieved_at: "2026-08-24T10:00:00+08:00" },
    warnings: [],
  },
  provenance: {
    invocation_id: "invocation-1",
    sources: [{ source_id: "source-1", title: "Example source", url: "https://example.test/product" }],
  },
  allowed_commands: [{ command_type: "product.refresh", schema_version: "1.0" }],
  correlation_id: "correlation-1",
  freshness: { retrieved_at: "2026-08-24T10:00:00+08:00" },
  warnings: [],
  fallback_text: "One headphone result from Example merchant.",
};

describe("generative UI protocol registry", () => {
  it("validates and transforms a registered product result", () => {
    const result = validateGenerativeUiPart(baseProductPart);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.part.component_type).toBe("product_results");
  });

  it.each([
    { ...baseProductPart, component_type: "custom_component" },
    { ...baseProductPart, schema_version: "2.0" },
  ])("rejects unknown identifiers and versions with a text fallback", (input) => {
    const result = validateGenerativeUiPart(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fallback.text).toBe(baseProductPart.fallback_text);
  });

  it("rejects payloads above item bounds", () => {
    const item = baseProductPart.props.items[0];
    const result = validateGenerativeUiPart({
      ...baseProductPart,
      props: { ...baseProductPart.props, items: Array.from({ length: 51 }, (_, index) => ({ ...item, id: `product-${index}` })) },
    });
    expect(result.ok).toBe(false);
  });

  it("requires source provenance and rejects executable presentation fields", () => {
    const result = validateGenerativeUiPart({
      ...baseProductPart,
      props: {
        ...baseProductPart.props,
        items: [{ ...baseProductPart.props.items[0], source_ids: [] }],
        html: "<script>alert(1)</script>",
      },
      provenance: { invocation_id: "invocation-1", sources: [] },
    });
    expect(result.ok).toBe(false);
  });
});
