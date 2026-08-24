import type { ProductResultItem, ProductResultProps } from "../../../../../packages/contracts/src/ui/product-result";
import { rawProductResultSchema } from "../../../../../packages/contracts/src/ui/product-result";

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base", numeric: true });
}

export function normalizeProductResults(input: unknown): ProductResultProps {
  const parsed = rawProductResultSchema.parse(input);
  const sourceIds = new Set(parsed.sources.map((source) => source.source_id));
  const items = parsed.items.slice(0, 50).map((item) => ({
    ...item,
    attributes: item.attributes.slice(0, 12),
    source_ids: item.source_ids.filter((sourceId) => sourceIds.has(sourceId)),
  })).filter((item) => item.source_ids.length > 0);

  return {
    ...parsed,
    items: items.sort(defaultProductOrder),
  };
}

export const transformProductResult = normalizeProductResults;

export function formatProductResultFallback(props: ProductResultProps): string {
  const lines = props.items.map((item) => {
    const price = item.price ? `${item.price.amount} ${item.price.currency}${item.price.unit ? ` per ${item.price.unit}` : ""}` : "price unavailable";
    return `${item.name} — ${price} — ${item.merchant} (${item.source_ids.join(", ")})`;
  });
  return lines.length > 0 ? lines.join("\n") : "No product results were returned.";
}

export function defaultProductOrder(left: ProductResultItem, right: ProductResultItem): number {
  return compareText(left.merchant, right.merchant)
    || compareText(left.name, right.name)
    || compareText(left.id, right.id);
}
