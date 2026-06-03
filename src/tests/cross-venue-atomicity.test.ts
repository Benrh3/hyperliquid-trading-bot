/**
 * Tests for CrossVenueFundingBasis leg-placement atomicity.
 *
 * Validates that when the second leg (dYdX long) fails after the first leg
 * (HL short) has already been placed, the strategy immediately unwinds the
 * first leg so no naked position is left open on the exchange.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Venue, VenuePosition, OrderReceipt } from "../venue.js";

// ── Minimal mock venue ─────────────────────────────────────────────────────────

class MockVenue implements Venue {
  readonly name: string;

  openCalls:  Array<{ coin: string; side: "long" | "short"; sizeUsd: number }> = [];
  closeCalls: Array<{ coin: string }> = [];

  private openShouldThrow:  Error | null = null;
  private closeShouldThrow: Error | null = null;

  constructor(name: string) { this.name = name; }

  failNextOpen(err: Error)  { this.openShouldThrow  = err; }
  failNextClose(err: Error) { this.closeShouldThrow = err; }

  async openPosition(coin: string, side: "long" | "short", sizeUsd: number): Promise<OrderReceipt> {
    this.openCalls.push({ coin, side, sizeUsd });
    if (this.openShouldThrow) {
      const e = this.openShouldThrow;
      this.openShouldThrow = null;
      throw e;
    }
    return { orderId: `mock-open-${this.name}-${Date.now()}`, fillPrice: 50_000, fillSize: sizeUsd / 50_000 };
  }

  async closePosition(coin: string): Promise<OrderReceipt> {
    this.closeCalls.push({ coin });
    if (this.closeShouldThrow) {
      const e = this.closeShouldThrow;
      this.closeShouldThrow = null;
      throw e;
    }
    return { orderId: `mock-close-${this.name}-${Date.now()}`, fillPrice: 50_000, fillSize: 0.02, pnl: -1 };
  }

  async getPosition(_coin: string): Promise<VenuePosition | null>   { return null; }
  async getFundingRate(_coin: string): Promise<number | null>        { return 0.0001; }
  async getMarkPrice(_coin: string):   Promise<number | null>        { return 50_000; }
  async getAccountEquity():            Promise<number | null>        { return 10_000; }
  async getAllPositions():              Promise<VenuePosition[]>      { return []; }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Import the class under test after mocking its dependencies. */
async function makeStrategy(
  venueA: Venue,
  venueB: Venue,
  notional = 1_000,
) {
  // We need the real module — vitest runs under tsx so the import works directly.
  const { CrossVenueFundingBasis } = await import("../cross-venue-funding.js");
  const strategy = new CrossVenueFundingBasis(venueA, venueB, "BTC", notional);
  strategy.setExecutionMode("live");
  return strategy;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CrossVenueFundingBasis — leg atomicity", () => {
  let hlVenue:   MockVenue;
  let dydxVenue: MockVenue;

  beforeEach(() => {
    hlVenue   = new MockVenue("hyperliquid");
    dydxVenue = new MockVenue("dydx");
    // Suppress console noise in tests
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("opens both legs when both venues succeed", async () => {
    const strategy = await makeStrategy(hlVenue, dydxVenue);
    // Patch rates so spread threshold is met
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (strategy as any)["rates"] = { hyperliquid: 0.001, dydx: 0.0005 };

    // Directly invoke openLegs (private — cast to any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (strategy as any).openLegs("hyperliquid", "dydx", 0.0005, 0.001, 0.0005);

    expect(hlVenue.openCalls).toHaveLength(1);
    expect(hlVenue.openCalls[0]).toMatchObject({ coin: "BTC", side: "short", sizeUsd: 1_000 });
    expect(dydxVenue.openCalls).toHaveLength(1);
    expect(dydxVenue.openCalls[0]).toMatchObject({ coin: "BTC", side: "long",  sizeUsd: 1_000 });

    // Both legs placed → strategy should show positioned
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy["positioned"]).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy["nakedLeg"]).toBeNull();
  });

  it("does NOT open HL when pre-flight detects dYdX unreachable", async () => {
    // dYdX returns null for mark price → pre-flight aborts before any order
    vi.spyOn(dydxVenue, "getMarkPrice").mockResolvedValue(null);
    const strategy = await makeStrategy(hlVenue, dydxVenue);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    strategy["rates"] = { hyperliquid: 0.001, dydx: 0.0005 };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (strategy as any).openLegs("hyperliquid", "dydx", 0.0005, 0.001, 0.0005);

    expect(hlVenue.openCalls).toHaveLength(0);   // ← zero orders placed
    expect(dydxVenue.openCalls).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy["positioned"]).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy["lastError"]).toContain("Pre-flight failed");
  });

  it("unwinds HL short when dYdX long fails", async () => {
    // dYdX will throw on openPosition
    dydxVenue.failNextOpen(new Error("dYdX unreachable — DYDX_TESTNET_MNEMONIC missing"));
    const strategy = await makeStrategy(hlVenue, dydxVenue);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    strategy["rates"] = { hyperliquid: 0.001, dydx: 0.0005 };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((strategy as any).openLegs("hyperliquid", "dydx", 0.0005, 0.001, 0.0005))
      .rejects.toThrow("Open aborted");

    // HL short was placed then immediately unwound
    expect(hlVenue.openCalls).toHaveLength(1);    // leg-1 placed
    expect(hlVenue.closeCalls).toHaveLength(1);   // leg-1 unwound
    expect(hlVenue.closeCalls[0].coin).toBe("BTC");

    // dYdX long was NOT placed (it threw)
    expect(dydxVenue.openCalls).toHaveLength(1);  // attempt was made, it threw

    // Bot must be flat — no naked position in internal state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy["positioned"]).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy["legs"]).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy["nakedLeg"]).toBeNull();  // unwind succeeded → naked cleared
  });

  it("records nakedLeg when unwind also fails", async () => {
    dydxVenue.failNextOpen(new Error("dYdX timeout"));
    hlVenue.failNextClose(new Error("HL close rejected"));  // unwind fails too
    const strategy = await makeStrategy(hlVenue, dydxVenue);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    strategy["rates"] = { hyperliquid: 0.001, dydx: 0.0005 };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((strategy as any).openLegs("hyperliquid", "dydx", 0.0005, 0.001, 0.0005))
      .rejects.toThrow("CRITICAL");

    // nakedLeg is set so the card shows the exposure
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy["nakedLeg"]).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy["nakedLeg"]?.venueId).toBe("hyperliquid");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy["nakedLeg"]?.side).toBe("short");
    // getBotState surfacess the naked leg in crossVenueLegs
    const state = strategy.getBotState();
    expect(state.crossVenueLegs).toHaveLength(1);
    expect(state.crossVenueLegs![0]).toMatchObject({ venue: "hyperliquid", side: "short" });
    expect(state.fundingDirection).toContain("NAKED LEG");
  });

  it("uses configured notional, not account equity", async () => {
    const strategy = await makeStrategy(hlVenue, dydxVenue, 500); // $500 notional
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    strategy["rates"] = { hyperliquid: 0.001, dydx: 0.0005 };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (strategy as any).openLegs("hyperliquid", "dydx", 0.0005, 0.001, 0.0005);

    // Each leg should be placed at the configured notional, not account equity (~$10k)
    expect(hlVenue.openCalls[0].sizeUsd).toBe(500);
    expect(dydxVenue.openCalls[0].sizeUsd).toBe(500);
  });

  it("refuses to place orders when notional is absurdly large", async () => {
    const strategy = await makeStrategy(hlVenue, dydxVenue, 200_000); // 200k > 100k limit
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    strategy["rates"] = { hyperliquid: 0.001, dydx: 0.0005 };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (strategy as any).openLegs("hyperliquid", "dydx", 0.0005, 0.001, 0.0005);

    expect(hlVenue.openCalls).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy["lastError"]).toContain("safety limit");
  });
});
