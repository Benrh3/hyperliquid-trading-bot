/**
 * Tests for the per-venue cex-agg adapters (BinanceSource, BybitSource,
 * OkxSource) — symbol resolution, OI/long-short-ratio fetches with mocked
 * `fetchFn`, "unsupported stat" nulling, and venue-unreachable (geo-block)
 * handling. No live network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BinanceSource } from "../market/cex/binance.js";
import { BybitSource } from "../market/cex/bybit.js";
import { OkxSource } from "../market/cex/okx.js";

/** Build a `fetch`-compatible mock: routes by substring match against the URL. */
function mockFetch(routes: { match: string; status?: number; body?: unknown }[]): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`mockFetch: no route for ${url}`);
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe("BinanceSource", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it("resolves the symbol, fetches coin-denominated OI, and parses all three long/short ratios", async () => {
    const fetchFn = mockFetch([
      { match: "/fapi/v1/openInterest", body: { symbol: "HYPEUSDT", openInterest: "1696356.4" } },
      { match: "globalLongShortAccountRatio", body: [{ longShortRatio: "1.1" }] },
      { match: "topLongShortPositionRatio", body: [{ longShortRatio: "1.4" }] },
      { match: "takerlongshortRatio", body: [{ buySellRatio: "1.05" }] },
    ]);
    const source = new BinanceSource({ fetchFn });

    expect(await source.resolveSymbol("HYPE")).toBe(true);
    expect(source.isAvailable()).toBe(true);
    expect(await source.fetchOpenInterest()).toBeCloseTo(1696356.4, 5);

    const lsr = await source.fetchLongShortRatios();
    expect(lsr).toEqual({ accountRatio: 1.1, topPositionRatio: 1.4, takerRatio: 1.05 });
  });

  it("marks the venue unavailable and nulls every metric when the symbol isn't listed (geo-block / 451)", async () => {
    const fetchFn = mockFetch([{ match: "/fapi/v1/openInterest", status: 451, body: {} }]);
    const source = new BinanceSource({ fetchFn });

    expect(await source.resolveSymbol("HYPE")).toBe(false);
    expect(source.isAvailable()).toBe(false);
    expect(await source.fetchOpenInterest()).toBeNull();
    expect(await source.fetchLongShortRatios()).toEqual({ accountRatio: null, topPositionRatio: null, takerRatio: null });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("warns only once across repeated failures", async () => {
    const fetchFn = mockFetch([{ match: "/fapi/v1/openInterest", status: 451, body: {} }]);
    const source = new BinanceSource({ fetchFn });
    await source.resolveSymbol("HYPE");
    await source.fetchOpenInterest();
    await source.fetchOpenInterest();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("BybitSource", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it("resolves the symbol, fetches coin-denominated OI, and derives accountRatio from buy/sell ratio", async () => {
    const fetchFn = mockFetch([
      { match: "/v5/market/instruments-info", body: { result: { list: [{ symbol: "HYPEUSDT" }] } } },
      { match: "/v5/market/open-interest", body: { result: { list: [{ openInterest: "3000000" }] } } },
      { match: "/v5/market/account-ratio", body: { result: { list: [{ buyRatio: "0.6", sellRatio: "0.4" }] } } },
    ]);
    const source = new BybitSource({ fetchFn });

    expect(await source.resolveSymbol("HYPE")).toBe(true);
    expect(source.isAvailable()).toBe(true);
    expect(await source.fetchOpenInterest()).toBe(3_000_000);

    const lsr = await source.fetchLongShortRatios();
    expect(lsr.accountRatio).toBeCloseTo(1.5, 10); // 0.6 / 0.4
    expect(lsr.topPositionRatio).toBeNull();
    expect(lsr.takerRatio).toBeNull();
  });

  it("marks the venue unavailable and nulls every metric when the symbol isn't listed", async () => {
    const fetchFn = mockFetch([{ match: "/v5/market/instruments-info", body: { result: { list: [] } } }]);
    const source = new BybitSource({ fetchFn });

    expect(await source.resolveSymbol("HYPE")).toBe(false);
    expect(source.isAvailable()).toBe(false);
    expect(await source.fetchOpenInterest()).toBeNull();
    expect(await source.fetchLongShortRatios()).toEqual({ accountRatio: null, topPositionRatio: null, takerRatio: null });
  });
});

describe("OkxSource", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it("resolves instId + ctVal, fetches coin-denominated OI (via oiCcy), and parses account/top-position ratios + taker ratio", async () => {
    const fetchFn = mockFetch([
      { match: "/api/v5/public/instruments", body: { code: "0", data: [{ instId: "HYPE-USDT-SWAP", ctVal: "0.1" }] } },
      { match: "/api/v5/public/open-interest", body: { code: "0", data: [{ oiCcy: "1700000" }] } },
      { match: "long-short-account-ratio-contract-top-trader", body: { code: "0", data: [["1700000000000", "1.17"]] } },
      { match: "long-short-account-ratio-contract", body: { code: "0", data: [["1700000000000", "1.03"]] } },
      { match: "taker-volume-contract", body: { code: "0", data: [["1700000000000", "1", "2.5"]] } },
    ]);
    const source = new OkxSource({ fetchFn });

    expect(await source.resolveSymbol("HYPE")).toBe(true);
    expect(source.isAvailable()).toBe(true);
    expect(await source.fetchOpenInterest()).toBe(1_700_000);

    const lsr = await source.fetchLongShortRatios();
    expect(lsr).toEqual({ accountRatio: 1.03, topPositionRatio: 1.17, takerRatio: 2.5 });
  });

  it("nulls only the unsupported rubik stat, leaving other ratio fields intact, and warns once", async () => {
    const fetchFn = mockFetch([
      { match: "/api/v5/public/instruments", body: { code: "0", data: [{ instId: "HYPE-USDT-SWAP", ctVal: "0.1" }] } },
      // top-trader ratio unsupported for this instrument (non-"0" code / empty data).
      { match: "long-short-account-ratio-contract-top-trader", body: { code: "51001", data: [] } },
      { match: "long-short-account-ratio-contract", body: { code: "0", data: [["1700000000000", "1.03"]] } },
      { match: "taker-volume-contract", body: { code: "0", data: [["1700000000000", "1", "2.5"]] } },
    ]);
    const source = new OkxSource({ fetchFn });
    await source.resolveSymbol("HYPE");

    const lsr = await source.fetchLongShortRatios();
    expect(lsr.topPositionRatio).toBeNull();
    expect(lsr.accountRatio).toBe(1.03);
    expect(lsr.takerRatio).toBe(2.5);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Calling again doesn't warn a second time for the same stat.
    await source.fetchLongShortRatios();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("marks the venue unavailable and nulls every metric when the instrument isn't listed", async () => {
    const fetchFn = mockFetch([{ match: "/api/v5/public/instruments", body: { code: "0", data: [] } }]);
    const source = new OkxSource({ fetchFn });

    expect(await source.resolveSymbol("HYPE")).toBe(false);
    expect(source.isAvailable()).toBe(false);
    expect(await source.fetchOpenInterest()).toBeNull();
    expect(await source.fetchLongShortRatios()).toEqual({ accountRatio: null, topPositionRatio: null, takerRatio: null });
  });
});
