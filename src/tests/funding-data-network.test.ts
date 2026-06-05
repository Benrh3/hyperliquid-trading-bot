/**
 * Tests for funding-matrix data-network selection and annualised rate clamping.
 * All functions under test are pure (no network, no side effects).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getFundingDataNetwork,
  getFundingDataUrls,
  clampAnnRate,
  ANN_RATE_CAP_PCT,
} from "../funding-matrix.js";

// ── clampAnnRate ──────────────────────────────────────────────────────────────

const HOURS_PER_YEAR = 8_760;
/** Convert an hourly fraction to annualised %. */
const ann = (r: number) => r * HOURS_PER_YEAR * 100;

describe("clampAnnRate", () => {
  it("passes through a normal positive rate unchanged", () => {
    // 0.0001/hr → ~0.876 %/yr — well within the ±300 cap
    const r      = 0.0001;
    const result = clampAnnRate(r);
    expect(result).not.toBeNull();
    expect(Math.abs(ann(result!) - ann(r))).toBeLessThan(1e-10);
  });

  it("passes through a normal negative rate unchanged", () => {
    const r      = -0.0002;
    const result = clampAnnRate(r);
    expect(result).not.toBeNull();
    expect(Math.abs(ann(result!) - ann(r))).toBeLessThan(1e-10);
  });

  it("clamps a massive positive rate to +ANN_RATE_CAP_PCT/yr", () => {
    // ASTR-style junk: -97950 %/yr equivalent
    const hugePosRate = 5.0; // +43 800 %/yr
    const result      = clampAnnRate(hugePosRate)!;
    expect(result).not.toBeNull();
    const annResult = result * HOURS_PER_YEAR * 100;
    expect(annResult).toBeCloseTo(ANN_RATE_CAP_PCT, 5);
  });

  it("clamps a massive negative rate to −ANN_RATE_CAP_PCT/yr", () => {
    const hugeNegRate = -5.0; // −43 800 %/yr
    const result      = clampAnnRate(hugeNegRate)!;
    expect(result).not.toBeNull();
    const annResult = result * HOURS_PER_YEAR * 100;
    expect(annResult).toBeCloseTo(-ANN_RATE_CAP_PCT, 5);
  });

  it("returns null for null input", () => {
    expect(clampAnnRate(null)).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(clampAnnRate(NaN)).toBeNull();
  });

  it("returns null for ±Infinity", () => {
    expect(clampAnnRate(Infinity)).toBeNull();
    expect(clampAnnRate(-Infinity)).toBeNull();
  });

  it("returns 0 for exactly 0", () => {
    const result = clampAnnRate(0);
    expect(result).toBe(0);
  });

  it("does not alter a rate right at the cap boundary", () => {
    // ANN_RATE_CAP_PCT %/yr expressed as hourly fraction
    const rAtCap = ANN_RATE_CAP_PCT / (HOURS_PER_YEAR * 100);
    const result = clampAnnRate(rAtCap)!;
    expect(ann(result)).toBeCloseTo(ANN_RATE_CAP_PCT, 5);
  });

  it("result round-trips: clampAnnRate(clampAnnRate(x)) === clampAnnRate(x)", () => {
    const hugePosRate = 100.0;
    const once  = clampAnnRate(hugePosRate)!;
    const twice = clampAnnRate(once)!;
    expect(once).toBeCloseTo(twice, 10);
  });
});

// ── getFundingDataNetwork ─────────────────────────────────────────────────────

describe("getFundingDataNetwork", () => {
  const origEnv = process.env.FUNDING_DATA_NETWORK;

  afterEach(() => {
    // Restore original env value
    if (origEnv === undefined) delete process.env.FUNDING_DATA_NETWORK;
    else process.env.FUNDING_DATA_NETWORK = origEnv;
  });

  it("returns 'mainnet' by default when env var is unset", () => {
    delete process.env.FUNDING_DATA_NETWORK;
    expect(getFundingDataNetwork()).toBe("mainnet");
  });

  it("returns 'mainnet' when explicitly set to 'mainnet'", () => {
    process.env.FUNDING_DATA_NETWORK = "mainnet";
    expect(getFundingDataNetwork()).toBe("mainnet");
  });

  it("returns 'testnet' when set to 'testnet'", () => {
    process.env.FUNDING_DATA_NETWORK = "testnet";
    expect(getFundingDataNetwork()).toBe("testnet");
  });

  it("is case-insensitive (TESTNET → testnet)", () => {
    process.env.FUNDING_DATA_NETWORK = "TESTNET";
    expect(getFundingDataNetwork()).toBe("testnet");
  });

  it("defaults to 'mainnet' for unknown values", () => {
    process.env.FUNDING_DATA_NETWORK = "staging";
    expect(getFundingDataNetwork()).toBe("mainnet");
  });

  it("trims whitespace before comparing", () => {
    process.env.FUNDING_DATA_NETWORK = "  testnet  ";
    expect(getFundingDataNetwork()).toBe("testnet");
  });
});

// ── getFundingDataUrls ────────────────────────────────────────────────────────

describe("getFundingDataUrls", () => {
  it("mainnet: hlIsTestnet=false and uses production dYdX indexer", () => {
    const { hlIsTestnet, dydxIndexer } = getFundingDataUrls("mainnet");
    expect(hlIsTestnet).toBe(false);
    expect(dydxIndexer).toContain("indexer.dydx.trade");
    expect(dydxIndexer).not.toContain("testnet");
  });

  it("testnet: hlIsTestnet=true and uses testnet dYdX indexer", () => {
    const { hlIsTestnet, dydxIndexer } = getFundingDataUrls("testnet");
    expect(hlIsTestnet).toBe(true);
    expect(dydxIndexer).toContain("testnet");
  });

  it("mainnet dYdX URL ends with /v4", () => {
    const { dydxIndexer } = getFundingDataUrls("mainnet");
    expect(dydxIndexer).toMatch(/\/v4$/);
  });

  it("testnet dYdX URL ends with /v4", () => {
    const { dydxIndexer } = getFundingDataUrls("testnet");
    expect(dydxIndexer).toMatch(/\/v4$/);
  });

  it("the two networks produce different URLs", () => {
    const mainnet = getFundingDataUrls("mainnet");
    const testnet = getFundingDataUrls("testnet");
    expect(mainnet.dydxIndexer).not.toBe(testnet.dydxIndexer);
    expect(mainnet.hlIsTestnet).not.toBe(testnet.hlIsTestnet);
  });
});
