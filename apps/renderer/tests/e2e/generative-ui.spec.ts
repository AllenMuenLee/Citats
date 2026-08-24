import { expect, test } from "@playwright/test";

const source = { source_id: "source-1", title: "Fixture source", url: "https://example.test/results" };
const envelope = {
  schema_version: "1.0",
  instance_id: "instance-1",
  result_digest: "a".repeat(64),
  provenance: { invocation_id: "invocation-1", sources: [source] },
  allowed_commands: [],
  correlation_id: "correlation-1",
  freshness: { retrieved_at: "2026-08-24T10:00:00+08:00" },
  warnings: [],
};
const product = {
  ...envelope,
  component_type: "product_results",
  props: {
    component_instance_id: "instance-1",
    query: "Fixture products",
    items: [{ id: "product-1", name: "Accessible headset", price: { amount: "99", currency: "USD" }, merchant: "Fixture shop", availability: "Available", attributes: [], source_ids: ["source-1"], partial_data_warnings: [] }],
    sources: [source], freshness: envelope.freshness, warnings: [],
  },
  fallback_text: "Accessible headset is USD 99.",
};
const flight = {
  ...envelope,
  instance_id: "instance-2",
  component_type: "flight_comparison",
  props: {
    component_instance_id: "instance-2",
    query: { origin: "TPE", destination: "NRT" },
    itineraries: [{ itinerary_id: "flight-1", legs: [{ leg_id: "leg-1", origin: "TPE", destination: "NRT", departure_at: "2026-10-01T08:00:00+08:00", arrival_at: "2026-10-01T12:00:00+09:00", duration_minutes: 180, carrier: "Fixture Air" }], total_duration_minutes: 180, stop_count: 0, carriers: ["Fixture Air"], fare: { amount: 250, currency: "USD" }, source_ids: ["source-1"], warnings: [] }],
    sources: [source], freshness: envelope.freshness, availability_disclaimer: "Prices and seats can change.", warnings: [],
  },
  fallback_text: "One fixture flight from TPE to NRT.",
};

async function mockStream(page: import("@playwright/test").Page, payload: unknown) {
  await page.route("**/api/chat", async (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ type: "text-delta", delta: "Comparison ready." })}\n\ndata: ${JSON.stringify({ type: "generative-ui", payload })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`,
  }));
}

test("streams product UI with keyboard controls at narrow and wide widths", async ({ page }) => {
  await mockStream(page, product);
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/");
  await page.getByRole("textbox").fill("Compare products");
  await page.getByRole("textbox").press("Tab");
  await page.getByRole("button", { name: "Send" }).press("Enter");
  await expect(page.getByRole("heading", { name: "Fixture products" })).toBeVisible();
  await page.getByLabel("Sort").selectOption("name");
  await expect(page.getByText("Sorted by name")).toBeAttached();
  await expect(page).toHaveScreenshot("product-narrow.png", { fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page).toHaveScreenshot("product-wide.png", { fullPage: true });
});

test("renders flight comparison and a safe version-mismatch fallback", async ({ page }) => {
  await mockStream(page, flight);
  await page.goto("/");
  await page.getByRole("textbox").fill("Compare flights");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "TPE to NRT" })).toBeVisible();
  await expect(page.getByText(/Verify availability/)).toBeVisible();
  await page.unroute("**/api/chat");
  await mockStream(page, { ...product, schema_version: "7.0", fallback_text: "Safe plain text result." });
  await page.getByRole("textbox").fill("Invalid version");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Safe plain text result." })).toBeVisible();
});
