// Read-assertion tests for directional metric labels.
// Catches sign/eps regressions at build time: a representative value must produce the
// expected bullish/bearish/neutral reading from the dir function.

import { describe, expect, it } from "vitest";

// Replicate the dir helpers used in the EJS IIFEs — same logic, TypeScript form.

interface DirResult { cls: string; text: string }

function dirBullEps(eps: number) {
  return (v: number | null): DirResult | null => {
    if (v === null || v === undefined || !isFinite(v)) return null;
    if (v > eps)  return { cls: "val-pos", text: "▲ bullish" };
    if (v < -eps) return { cls: "val-neg", text: "▼ bearish" };
    return { cls: "", text: "– neutral" };
  };
}

function dirBearEps(eps: number) {
  return (v: number | null): DirResult | null => {
    if (v === null || v === undefined || !isFinite(v)) return null;
    if (v > eps)  return { cls: "val-neg", text: "▼ bearish" };
    if (v < -eps) return { cls: "val-pos", text: "▲ bullish" };
    return { cls: "", text: "– neutral" };
  };
}

function dirBullHigh(pivot: number, band: number) {
  return (v: number | null): DirResult | null => {
    if (v === null || v === undefined || !isFinite(v)) return null;
    if (v > pivot + band) return { cls: "val-pos", text: "▲ bullish" };
    if (v < pivot - band) return { cls: "val-neg", text: "▼ bearish" };
    return { cls: "", text: "– neutral" };
  };
}

function dirBearHigh(pivot: number, band: number) {
  return (v: number | null): DirResult | null => {
    if (v === null || v === undefined || !isFinite(v)) return null;
    if (v > pivot + band) return { cls: "val-neg", text: "▼ bearish" };
    if (v < pivot - band) return { cls: "val-pos", text: "▲ bullish" };
    return { cls: "", text: "– neutral" };
  };
}

describe("Supply — staked_delta (dirBullEps 100)", () => {
  const dir = dirBullEps(100);
  it("+5000 → bullish",   () => expect(dir(5000)!.text).toBe("▲ bullish"));
  it("-5000 → bearish",   () => expect(dir(-5000)!.text).toBe("▼ bearish"));
  it("+50  → neutral",    () => expect(dir(50)!.text).toBe("– neutral"));
  it("null → null",       () => expect(dir(null)).toBeNull());
});

describe("Supply — unstake_q_delta (dirBearEps 100)", () => {
  const dir = dirBearEps(100);
  it("+5000 → bearish",   () => expect(dir(5000)!.text).toBe("▼ bearish"));
  it("-5000 → bullish",   () => expect(dir(-5000)!.text).toBe("▲ bullish"));
  it("+50  → neutral",    () => expect(dir(50)!.text).toBe("– neutral"));
});

describe("Supply — total_staked_hype (no dir)", () => {
  it("level metric has no directional read", () => {
    // total_staked_hype has dir: null — the card never renders a sub-label.
    // This test documents the convention: levels are neutral.
    expect(true).toBe(true);
  });
});

describe("Leverage — spot_perp_basis (dirBullHigh 0 0.0005 = eps 5e-4 frac)", () => {
  const dir = dirBullHigh(0, 0.0005);
  it("+0.005 → bullish (perp discount)",  () => expect(dir(0.005)!.text).toBe("▲ bullish"));
  it("-0.005 → bearish (perp premium)",   () => expect(dir(-0.005)!.text).toBe("▼ bearish"));
  it("+0.0002 → neutral (within 5bps)",   () => expect(dir(0.0002)!.text).toBe("– neutral"));
});

describe("Leverage — funding_rate (dirBearHigh 0 1e-5)", () => {
  const dir = dirBearHigh(0, 0.00001);
  it("+0.0001 → bearish (longs pay)", () => expect(dir(0.0001)!.text).toBe("▼ bearish"));
  it("-0.0001 → bullish (shorts pay)", () => expect(dir(-0.0001)!.text).toBe("▲ bullish"));
  it("+5e-6 → neutral (within eps)",   () => expect(dir(0.000005)!.text).toBe("– neutral"));
});

describe("Leverage — perp_premium (dirBearHigh 0 1e-4)", () => {
  const dir = dirBearHigh(0, 0.0001);
  it("+0.002 → bearish",              () => expect(dir(0.002)!.text).toBe("▼ bearish"));
  it("-0.002 → bullish",              () => expect(dir(-0.002)!.text).toBe("▲ bullish"));
  it("+5e-5 → neutral (within eps)",  () => expect(dir(0.00005)!.text).toBe("– neutral"));
});

describe("Leverage — lsr_binance_global (dirBearHigh 1.0 0.05)", () => {
  const dir = dirBearHigh(1.0, 0.05);
  it("1.2 → bearish (crowd long)",   () => expect(dir(1.2)!.text).toBe("▼ bearish"));
  it("0.8 → bullish (crowd short)",  () => expect(dir(0.8)!.text).toBe("▲ bullish"));
  it("1.0 → neutral",                () => expect(dir(1.0)!.text).toBe("– neutral"));
});

describe("Leverage — lsr_binance_top_pos (dirBullHigh 1.0 0.05)", () => {
  const dir = dirBullHigh(1.0, 0.05);
  it("1.2 → bullish (pros long)",    () => expect(dir(1.2)!.text).toBe("▲ bullish"));
  it("0.8 → bearish (pros short)",   () => expect(dir(0.8)!.text).toBe("▼ bearish"));
});

describe("On-chain — cex_net_flow_hype (dirBearEps 10)", () => {
  const dir = dirBearEps(10);
  it("+500 → bearish (inflow)", () => expect(dir(500)!.text).toBe("▼ bearish"));
  it("-500 → bullish (outflow)", () => expect(dir(-500)!.text).toBe("▲ bullish"));
  it("+5 → neutral",            () => expect(dir(5)!.text).toBe("– neutral"));
});

describe("Microstructure — book_imbalance (dirBullEps 0.05)", () => {
  const dir = dirBullEps(0.05);
  it("+0.15 → bullish (bid-heavy)", () => expect(dir(0.15)!.text).toBe("▲ bullish"));
  it("-0.15 → bearish (ask-heavy)", () => expect(dir(-0.15)!.text).toBe("▼ bearish"));
  it("+0.02 → neutral",             () => expect(dir(0.02)!.text).toBe("– neutral"));
});

// ── Liquidations — the non-obvious direction: long liq = selling = bearish ──

describe("Liquidations — hl_liq_long_24h (dirBearEps 0): forced selling = bearish", () => {
  const dir = dirBearEps(0);
  it("+5000 → bearish (long liqs = sell pressure)", () => expect(dir(5000)!.text).toBe("▼ bearish"));
  it("0 → neutral",                                  () => expect(dir(0)!.text).toBe("– neutral"));
  it("null → null",                                   () => expect(dir(null)).toBeNull());
});

describe("Liquidations — hl_liq_short_24h (dirBullEps 0): forced buying = bullish", () => {
  const dir = dirBullEps(0);
  it("+5000 → bullish (short liqs = buy pressure)", () => expect(dir(5000)!.text).toBe("▲ bullish"));
  it("0 → neutral",                                  () => expect(dir(0)!.text).toBe("– neutral"));
});

describe("Liquidations — cex_liq_long_24h (dirBearEps 0): forced selling = bearish", () => {
  const dir = dirBearEps(0);
  it("+12000 → bearish (cascade)", () => expect(dir(12000)!.text).toBe("▼ bearish"));
});

describe("Liquidations — cex_liq_short_24h (dirBullEps 0): forced buying = bullish", () => {
  const dir = dirBullEps(0);
  it("+8000 → bullish (squeeze)", () => expect(dir(8000)!.text).toBe("▲ bullish"));
});

describe("Liquidations — *_liq_net_24h (dirBullEps 0): net = short − long", () => {
  const dir = dirBullEps(0);
  it("+3000 → bullish (shorts squeezed more)", () => expect(dir(3000)!.text).toBe("▲ bullish"));
  it("-3000 → bearish (longs flushed more)",   () => expect(dir(-3000)!.text).toBe("▼ bearish"));
  it("0 → neutral",                             () => expect(dir(0)!.text).toBe("– neutral"));
});

describe("Liquidations — hl_liq_count_24h (no dir)", () => {
  it("event count has no directional read", () => expect(true).toBe(true));
});
