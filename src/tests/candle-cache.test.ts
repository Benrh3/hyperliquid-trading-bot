import { describe, it, expect } from "vitest";
import { makeCacheKey, isValidCoin, isValidInterval, VALID_INTERVALS } from "../candle-cache-utils.js";

// ── makeCacheKey ──────────────────────────────────────────────────────────────

describe("makeCacheKey", () => {
  it("uppercases the coin symbol", () => {
    expect(makeCacheKey("btc", "1h")).toBe("BTC:1h");
  });
  it("trims whitespace from coin", () => {
    expect(makeCacheKey("  ETH  ", "1h")).toBe("ETH:1h");
  });
  it("preserves interval exactly", () => {
    expect(makeCacheKey("SOL", "1d")).toBe("SOL:1d");
  });
  it("produces different keys for different intervals", () => {
    const k1 = makeCacheKey("BTC", "1h");
    const k2 = makeCacheKey("BTC", "4h");
    expect(k1).not.toBe(k2);
  });
  it("produces different keys for different coins", () => {
    const k1 = makeCacheKey("BTC", "1h");
    const k2 = makeCacheKey("ETH", "1h");
    expect(k1).not.toBe(k2);
  });
  it("case-insensitive coin gives the same key", () => {
    expect(makeCacheKey("btc", "1m")).toBe(makeCacheKey("BTC", "1m"));
    expect(makeCacheKey("Eth", "4h")).toBe(makeCacheKey("ETH", "4h"));
  });
  it("key contains both coin and interval separated by colon", () => {
    const key = makeCacheKey("HYPE", "15m");
    expect(key).toContain("HYPE");
    expect(key).toContain("15m");
    expect(key).toContain(":");
  });
});

// ── isValidCoin ───────────────────────────────────────────────────────────────

describe("isValidCoin", () => {
  const universe = ["BTC", "ETH", "SOL", "HYPE", "WLD"];

  it("returns true for a coin in the universe (exact match)", () => {
    expect(isValidCoin("BTC", universe)).toBe(true);
  });
  it("returns true for a lowercase coin (case-insensitive)", () => {
    expect(isValidCoin("btc", universe)).toBe(true);
  });
  it("returns true for a mixed-case coin", () => {
    expect(isValidCoin("Hype", universe)).toBe(true);
  });
  it("returns false for a coin not in the universe", () => {
    expect(isValidCoin("DOGE", universe)).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(isValidCoin("", universe)).toBe(false);
  });
  it("returns false for a non-string input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidCoin(null as any, universe)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidCoin(undefined as any, universe)).toBe(false);
  });
  it("returns false when universe is empty", () => {
    expect(isValidCoin("BTC", [])).toBe(false);
  });
  it("trims whitespace before matching", () => {
    expect(isValidCoin("  SOL  ", universe)).toBe(true);
  });
  it("returns false for partial matches", () => {
    expect(isValidCoin("BTC1", universe)).toBe(false);
    expect(isValidCoin("B", universe)).toBe(false);
  });
});

// ── isValidInterval ───────────────────────────────────────────────────────────

describe("isValidInterval", () => {
  it("returns true for all known intervals", () => {
    for (const iv of VALID_INTERVALS) {
      expect(isValidInterval(iv)).toBe(true);
    }
  });
  it("returns false for unknown intervals", () => {
    expect(isValidInterval("2m")).toBe(false);
    expect(isValidInterval("6h")).toBe(false);
    expect(isValidInterval("1w")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(isValidInterval("")).toBe(false);
  });
  it("is case-sensitive (HL API uses lowercase)", () => {
    expect(isValidInterval("1H")).toBe(false);
    expect(isValidInterval("1D")).toBe(false);
  });
});
