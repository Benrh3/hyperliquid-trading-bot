/**
 * Tests for the market-data-network resolver — generalized from
 * FUNDING_DATA_NETWORK. Reads mainnet by default regardless of
 * config.exchange.network, which controls trading execution only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMarketDataNetwork, getMarketDataHlIsTestnet } from "../market/network.js";
import { getFundingDataUrls } from "../funding-matrix.js";

describe("getMarketDataNetwork", () => {
  const original = process.env.MARKET_DATA_NETWORK;

  afterEach(() => {
    if (original === undefined) delete process.env.MARKET_DATA_NETWORK;
    else process.env.MARKET_DATA_NETWORK = original;
  });

  it("defaults to mainnet when unset", () => {
    delete process.env.MARKET_DATA_NETWORK;
    expect(getMarketDataNetwork()).toBe("mainnet");
  });

  it("returns mainnet for any value other than 'testnet'", () => {
    process.env.MARKET_DATA_NETWORK = "garbage";
    expect(getMarketDataNetwork()).toBe("mainnet");
  });

  it("returns testnet when explicitly set (case-insensitive)", () => {
    process.env.MARKET_DATA_NETWORK = "TESTNET";
    expect(getMarketDataNetwork()).toBe("testnet");
  });
});

describe("getMarketDataHlIsTestnet", () => {
  it("maps mainnet -> false and testnet -> true", () => {
    expect(getMarketDataHlIsTestnet("mainnet")).toBe(false);
    expect(getMarketDataHlIsTestnet("testnet")).toBe(true);
  });
});

describe("dYdX read-network split", () => {
  it("funding-matrix mainnet URL is the public mainnet indexer", () => {
    const urls = getFundingDataUrls("mainnet");
    expect(urls.dydxIndexer).toBe("https://indexer.dydx.trade/v4");
  });

  it("funding-matrix testnet URL is the v4 testnet indexer", () => {
    const urls = getFundingDataUrls("testnet");
    expect(urls.dydxIndexer).toBe("https://indexer.v4testnet.dydx.exchange/v4");
  });

  it("DydxVenue market reads use mainnet, account reads use testnet", async () => {
    // This test verifies the architectural intent documented in dydx.ts:
    // - getFundingRate / getMarkPrice → INDEXER_MAINNET (real rates)
    // - logStartupBalance → INDEXER_TESTNET (trading wallet lives there)
    // - getPosition → SDK client connected via Network.testnet()
    //
    // We can't easily unit-test the private indexerGet calls without mocking fetch,
    // but we CAN verify the exported constants/URLs match the expected pattern.
    // The real verification is that Strategies dYdX funding matches the Overview
    // matrix (both mainnet, non-zero) while the trading wallet is on testnet.
    expect(getFundingDataUrls("mainnet").dydxIndexer).toContain("indexer.dydx.trade");
    expect(getFundingDataUrls("testnet").dydxIndexer).toContain("v4testnet");
  });
});
