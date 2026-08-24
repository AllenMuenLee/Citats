import type { ProductResultProps } from "../../../../packages/contracts/src/ui/product-result";

const retrieved = "2026-08-24T08:00:00+00:00";
const source = { source_id: "source-1", title: "Example merchant", url: "https://shop.example/products" };

export const oneProductFixture: ProductResultProps = {
  component_instance_id: "product-one",
  query: "Quiet keyboards",
  items: [{ id: "keyboard-1", name: "Quiet Board", price: { amount: "89.95", currency: "USD" }, merchant: "Example", availability: "In stock", image_url: "https://images.example/keyboard.png", attributes: [{ name: "Switch", value: "Silent linear" }], source_ids: [source.source_id], partial_data_warnings: [] }],
  sources: [source], freshness: { retrieved_at: retrieved, stale_after: "2026-08-25T08:00:00+00:00" }, warnings: [],
};

export const manyProductFixture: ProductResultProps = { ...oneProductFixture, component_instance_id: "product-many", items: Array.from({ length: 8 }, (_, index) => ({ ...oneProductFixture.items[0], id: `keyboard-${index}`, name: `Keyboard ${index}` })) };
export const partialProductFixture: ProductResultProps = { ...oneProductFixture, component_instance_id: "product-partial", items: [{ ...oneProductFixture.items[0], price: undefined, partial_data_warnings: ["Price was not supplied"] }], warnings: [{ code: "partial_data", message: "Some merchants omitted prices." }] };
export const staleProductFixture: ProductResultProps = { ...oneProductFixture, component_instance_id: "product-stale", freshness: { retrieved_at: "2026-08-20T08:00:00+00:00", stale_after: "2026-08-21T08:00:00+00:00" }, warnings: [{ code: "stale_data", message: "Refresh before relying on availability." }] };
export const mixedCurrencyProductFixture: ProductResultProps = { ...oneProductFixture, component_instance_id: "product-currencies", items: [{ ...oneProductFixture.items[0], id: "usd", price: { amount: "80", currency: "USD" } }, { ...oneProductFixture.items[0], id: "eur", price: { amount: "70", currency: "EUR" } }] };

export const productResultFixtures = { one: oneProductFixture, many: manyProductFixture, partial: partialProductFixture, stale: staleProductFixture, mixedCurrency: mixedCurrencyProductFixture };

