/**
 * Tests for the market-data-network resolver — generalized from
 * FUNDING_DATA_NETWORK. Reads mainnet by default regardless of
 * config.exchange.network, which controls trading execution only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMarketDataNetwork, getMarketDataHlIsTestnet } from "../market/network.js";

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
