// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlightComparison } from "../../src/components/generative-ui/flight-comparison";
import { emptyFlightFixture, flightFixture } from "./flight-fixtures";

afterEach(cleanup);

describe("FlightComparison", () => {
  it("renders overnight/DST offsets, multi-leg stops, fare caveats, warnings, and provenance", () => {
    render(<FlightComparison {...flightFixture} component_instance_id="instance-1" />);
    expect(screen.getAllByText("01:30 (UTC-07:00)").length).toBeGreaterThan(0);
    expect(screen.getByText("1 stops via ORD")).toBeInTheDocument();
    expect(screen.getByText("Round trip, taxes included")).toBeInTheDocument();
    expect(screen.getByText("Fare unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Verify availability/)).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: "Example Flights" });
    expect(links[0]).toHaveAttribute("href", "https://flights.example/results");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("sorts and filters deterministically without comparing currencies numerically", async () => {
    const user = userEvent.setup(); render(<FlightComparison {...flightFixture} component_instance_id="instance-1" />);
    const list = screen.getAllByRole("list")[0]!;
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("CAD 440");
    await user.selectOptions(screen.getByRole("combobox", { name: "Departure" }), "evening");
    expect(screen.getByText("Showing 1 flight options sorted by price.")).toBeInTheDocument();
    expect(screen.getByText("Fare unavailable")).toBeInTheDocument();
  });

  it("updates local comparison state and emits only a read-only detail command", async () => {
    const user = userEvent.setup(); const onCommand = vi.fn();
    render(<FlightComparison {...flightFixture} component_instance_id="instance-1" onCommand={onCommand} />);
    await user.click(screen.getAllByRole("button", { name: "Compare" })[0]!);
    expect(screen.getByText("1 option selected for comparison.")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Request details" })[0]!);
    expect(onCommand).toHaveBeenCalledWith({ command_type: "flight.detail", component_instance_id: "instance-1", arguments: { itinerary_id: "multi-leg" } });
    expect(screen.queryByRole("button", { name: /book/i })).not.toBeInTheDocument();
  });

  it("uses semantic expandable details and supports empty/loading/error states", async () => {
    const user = userEvent.setup(); const { rerender } = render(<FlightComparison {...flightFixture} component_instance_id="instance-1" />);
    await user.click(screen.getAllByText("Leg details")[0]!);
    expect(screen.getByText("SFO to ORD")).toBeVisible();
    rerender(<FlightComparison {...emptyFlightFixture} component_instance_id="instance-1" />);
    expect(screen.getByText(/No flight options/)).toBeInTheDocument();
    rerender(<FlightComparison {...emptyFlightFixture} component_instance_id="instance-1" loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    rerender(<FlightComparison {...emptyFlightFixture} component_instance_id="instance-1" error="Unavailable" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
  });
});
