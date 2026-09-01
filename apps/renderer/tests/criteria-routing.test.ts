import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SITE_ADAPTERS,
  describeUnrepresentedCriteria,
  selectCollectionUrl,
  selectCollectionUrlFromDiscovery,
} from "../src/server/orchestrator/collection-url";
import { parseGoalCriteria } from "../src/server/orchestrator/goal-criteria";

/** A fixed "today" so every date resolution below is deterministic. */
const NOW = new Date("2026-09-01T12:00:00Z");

const REGRESSION_PROMPT =
  "give me 6 airbnb listings from seattle that's available from sep 3 to 5, and generate a UI for me to compare";

describe("goal criteria parsing (P03-R04 steps 1-2)", () => {
  it("keeps the regression prompt's dates, count, and place", () => {
    const criteria = parseGoalCriteria(REGRESSION_PROMPT, NOW);
    expect(criteria.dates).toEqual({ checkIn: "2026-09-03", checkOut: "2026-09-05" });
    expect(criteria.resultCount).toBe(6);
    expect(criteria.location?.toLowerCase()).toContain("seattle");
    expect(criteria.datesWording).toContain("sep 3");
    expect(criteria.unresolved).toEqual([]);
  });

  it("resolves a bare month/day to its next future occurrence", () => {
    // Already past on the fixed "today", so it belongs to next year.
    expect(parseGoalCriteria("stay from feb 3 to 5", NOW).dates)
      .toEqual({ checkIn: "2027-02-03", checkOut: "2027-02-05" });
    // Still ahead this year.
    expect(parseGoalCriteria("stay from dec 3 to 5", NOW).dates)
      .toEqual({ checkIn: "2026-12-03", checkOut: "2026-12-05" });
  });

  it("rolls the year forward across a year boundary rather than reversing", () => {
    expect(parseGoalCriteria("dec 30 to jan 2", NOW).dates)
      .toEqual({ checkIn: "2026-12-30", checkOut: "2027-01-02" });
  });

  it("resolves a leap date to the next year that actually has one", () => {
    expect(parseGoalCriteria("feb 29 to mar 2", NOW).dates)
      .toEqual({ checkIn: "2028-02-29", checkOut: "2028-03-02" });
  });

  it("rejects reversed and impossible ranges instead of guessing", () => {
    const reversed = parseGoalCriteria("sep 5 to 3", NOW);
    expect(reversed.dates).toBeUndefined();
    expect(reversed.unresolved).toEqual(["a reversed check-in/check-out range"]);

    const impossible = parseGoalCriteria("feb 30 to mar 2", NOW);
    expect(impossible.dates).toBeUndefined();
    expect(impossible.unresolved[0]).toContain("impossible");

    const backwardsIso = parseGoalCriteria("2026-09-05 to 2026-09-03", NOW);
    expect(backwardsIso.dates).toBeUndefined();
    expect(backwardsIso.unresolved).toHaveLength(1);
  });

  it("reads explicit ISO ranges and guest counts", () => {
    const criteria = parseGoalCriteria("book 2026-10-01 to 2026-10-04 for 3 guests", NOW);
    expect(criteria.dates).toEqual({ checkIn: "2026-10-01", checkOut: "2026-10-04" });
    expect(criteria.guests).toBe(3);
  });

  it("collects nothing about payment, credentials, or identity", () => {
    const criteria = parseGoalCriteria(
      "book sep 3 to 5 with my visa 4111 1111 1111 1111, login bob@example.com password hunter2",
      NOW,
    );
    expect(JSON.stringify(criteria)).not.toContain("4111");
    expect(JSON.stringify(criteria)).not.toContain("hunter2");
    expect(JSON.stringify(criteria)).not.toContain("bob@example.com");
  });

  it("returns no dates rather than a wrong range when none are stated", () => {
    const criteria = parseGoalCriteria("find me somewhere nice in Seattle", NOW);
    expect(criteria.dates).toBeUndefined();
    expect(criteria.unresolved).toEqual([]);
  });
});

describe("first-party collection URL selection (P03-R04 steps 3-6)", () => {
  const criteria = parseGoalCriteria(REGRESSION_PROMPT, NOW);

  it("keeps September 3-5 instead of falling back to a generic landing page", () => {
    const discovery = "Best results: https://www.airbnb.com/seattle-wa/stays for Seattle stays.";
    const selection = selectCollectionUrlFromDiscovery(discovery, criteria)!;

    const url = new URL(selection.url);
    expect(url.origin).toBe("https://www.airbnb.com");
    expect(url.pathname).toBe("/seattle-wa/stays");
    expect(url.searchParams.get("check_in")).toBe("2026-09-03");
    expect(url.searchParams.get("check_out")).toBe("2026-09-05");
    expect(selection.representedCriteria).toEqual(["checkIn", "checkOut"]);
    expect(selection.unrepresentedCriteria).toEqual([]);
  });

  it("encodes a guest count when the user stated one", () => {
    const withGuests = parseGoalCriteria("airbnb seattle sep 3 to 5 for 4 guests", NOW);
    const selection = selectCollectionUrl("https://www.airbnb.com/seattle-wa/stays", withGuests)!;
    expect(new URL(selection.url).searchParams.get("adults")).toBe("4");
    expect(selection.representedCriteria).toContain("guests");
  });

  it("prefers a collection path over a deep link on the same reviewed origin", () => {
    const discovery = [
      "https://www.airbnb.com/rooms/12345",
      "https://www.airbnb.com/seattle-wa/stays",
    ].join(" ");
    expect(new URL(selectCollectionUrlFromDiscovery(discovery, criteria)!.url).pathname)
      .toBe("/seattle-wa/stays");
  });

  it("strips tracking parameters and keeps only the site's own supported ones", () => {
    const selection = selectCollectionUrl(
      "https://www.airbnb.com/seattle-wa/stays?utm_source=news&gclid=abc&ref=promo&query=Seattle&evil=1",
      criteria,
    )!;
    const params = new URL(selection.url).searchParams;
    expect(params.get("query")).toBe("Seattle");
    expect(params.get("utm_source")).toBeNull();
    expect(params.get("gclid")).toBeNull();
    expect(params.get("ref")).toBeNull();
    expect(params.get("evil")).toBeNull();
  });

  it("lets the user's own criteria win over parameters the discovered URL carried", () => {
    const selection = selectCollectionUrl(
      "https://www.airbnb.com/seattle-wa/stays?check_in=2030-01-01&check_out=2030-01-09",
      criteria,
    )!;
    const params = new URL(selection.url).searchParams;
    expect(params.get("check_in")).toBe("2026-09-03");
    expect(params.get("check_out")).toBe("2026-09-05");
  });

  it("refuses unsafe origins and redirection shapes outright", () => {
    for (const unsafe of [
      "http://www.airbnb.com/seattle-wa/stays",
      "https://user:pass@www.airbnb.com/seattle-wa/stays",
      "https://www.airbnb.com:8443/seattle-wa/stays",
      "https://169.254.169.254/latest/meta-data",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]) {
      expect(selectCollectionUrl(unsafe, criteria)).toBeNull();
    }
  });

  it("never rewrites an origin it has no reviewed adapter for, and says so", () => {
    const selection = selectCollectionUrl("https://stays.example.com/seattle?check_in=2030-01-01", criteria)!;
    expect(selection.adapterId).toBeNull();
    expect(selection.url).toBe("https://stays.example.com/seattle");
    expect(selection.representedCriteria).toEqual([]);
    expect(selection.unrepresentedCriteria).toEqual(["checkIn", "checkOut"]);
    expect(describeUnrepresentedCriteria(selection)).toContain("not filtered by the requested");
  });

  it("falls back to discovery alone when no first-party candidate is usable", () => {
    // Step 5: no URL is invented when discovery surfaced nothing reviewed.
    expect(selectCollectionUrlFromDiscovery("No useful links were found.", criteria)).toBeNull();
    expect(selectCollectionUrlFromDiscovery("See https://blog.example.com/seattle-tips", criteria))
      .toBeNull();
  });

  it("never synthesizes a path from the user's words", () => {
    // The hard-coded "https://www.airbnb.com/seattle-wa/stays" this replaces
    // was produced from the prompt text alone, with no discovered evidence.
    expect(selectCollectionUrlFromDiscovery("airbnb seattle september", criteria)).toBeNull();
  });

  it("keeps site knowledge declarative rather than in control flow", () => {
    for (const adapter of SITE_ADAPTERS) {
      expect(adapter.origins.length).toBeGreaterThan(0);
      // Exact hostnames only -- never a suffix match that a lookalike could pass.
      expect(adapter.origins.every((origin) => !origin.includes("*"))).toBe(true);
      expect(Object.keys(adapter.params).length).toBeGreaterThan(0);
    }
  });

  it("bounds parameter values from an untrusted candidate", () => {
    const huge = `https://www.airbnb.com/seattle-wa/stays?query=${"x".repeat(500)}`;
    expect(new URL(selectCollectionUrl(huge, criteria)!.url).searchParams.get("query")).toBeNull();
  });
});
