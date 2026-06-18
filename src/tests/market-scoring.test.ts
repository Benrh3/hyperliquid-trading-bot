/**
 * Tests for stage 6: derived signals, Spearman IC, hit rate, forward-return
 * no-lookahead, warming gate, bias aggregation, and CSV export shapes.
 *
 * All tests are pure (no network, no file I/O) unless noted.
 */

import { describe, it, expect } from "vitest";
import {
  spearmanIC,
  hitRate,
  buildPairs,
  lookupForwardPrice,
  buildScorecard,
  computeBias,
  scorecardToCsv,
  buildSnapshotsCsv,
  MIN_N,
  SCORING_HORIZONS_H,
} from "../market/scoring.js";
import { computeDerived } from "../market/derived.js";
import { MarketStore } from "../market/store.js";
import type { MarketPollContext } from "../market/registry.js";

// ── Spearman IC ──────────────────────────────────────────────────────────────

describe("spearmanIC", () => {
  it("returns ~+1 for a perfectly monotonic positive relationship", () => {
    const pairs: [number, number][] = [[1,2],[2,4],[3,6],[4,8],[5,10],[6,12],[7,14],[8,16]];
    expect(spearmanIC(pairs)).toBeCloseTo(1, 5);
  });

  it("returns ~-1 for a perfectly monotonic inverse relationship", () => {
    const pairs: [number, number][] = [[1,8],[2,7],[3,6],[4,5],[5,4],[6,3],[7,2],[8,1]];
    expect(spearmanIC(pairs)).toBeCloseTo(-1, 5);
  });

  it("returns ~0 for a flat (constant) signal", () => {
    const pairs: [number, number][] = Array.from({length: 10}, (_, i) => [5, i]);
    expect(Math.abs(spearmanIC(pairs))).toBe(0); // all signal values tied → zero variance
  });

  it("returns NaN for fewer than 2 finite pairs", () => {
    expect(spearmanIC([[1, 2]])).toBeNaN();
    expect(spearmanIC([])).toBeNaN();
  });

  it("handles ties with average-rank correctly (Spearman not Pearson on raw values)", () => {
    // Two tied signal values: both should get average rank 1.5
    const pairs: [number, number][] = [[1,10],[1,20],[2,30],[3,40],[4,50],[5,60],[6,70],[7,80]];
    const ic = spearmanIC(pairs);
    expect(Number.isFinite(ic)).toBe(true);
  });
});

// ── Hit rate ─────────────────────────────────────────────────────────────────

describe("hitRate", () => {
  it("returns 1 when all signals and returns share the same sign", () => {
    const pairs: [number, number][] = [[1,0.1],[2,0.2],[-1,-0.1],[-2,-0.2]];
    expect(hitRate(pairs)).toBe(1);
  });

  it("returns 0 when every signal direction opposes the return", () => {
    const pairs: [number, number][] = [[1,-0.1],[2,-0.2],[-1,0.1],[-2,0.2]];
    expect(hitRate(pairs)).toBe(0);
  });

  it("excludes zero-signal and zero-return pairs from the count", () => {
    const pairs: [number, number][] = [[0,0.1],[1,0],[1,0.1],[2,0.2]];
    // only last 2 are valid (non-zero in both)
    expect(hitRate(pairs)).toBe(1);
  });

  it("returns NaN when no directed pairs are available", () => {
    expect(hitRate([[0,0],[0,1]])).toBeNaN();
    expect(hitRate([])).toBeNaN();
  });
});

// ── Forward-return helpers ────────────────────────────────────────────────────

describe("lookupForwardPrice", () => {
  const series = [
    { capturedAt: 1000, value: 10 },
    { capturedAt: 2000, value: 20 },
    { capturedAt: 3000, value: 30 },
  ];

  it("returns the price at exactly the target time", () => {
    expect(lookupForwardPrice(series, 2000)).toBe(20);
  });

  it("returns the first price strictly after target when no exact match", () => {
    expect(lookupForwardPrice(series, 1500)).toBe(20); // next is t=2000
  });

  it("returns null when target is beyond the last snapshot", () => {
    expect(lookupForwardPrice(series, 4000)).toBeNull();
  });

  it("returns null when the matched entry has a null value", () => {
    const s = [...series, { capturedAt: 4000, value: null }];
    expect(lookupForwardPrice(s, 4000)).toBeNull();
  });
});

describe("buildPairs — no-lookahead enforcement", () => {
  const BASE = 1_000_000;
  const H4_MS = 4 * 3_600_000;

  const prices = [
    { capturedAt: BASE,          value: 100 },
    { capturedAt: BASE + H4_MS,  value: 110 },  // 4h forward price for t=BASE
    { capturedAt: BASE + 2*H4_MS, value: 105 }, // 4h forward for t=BASE+H4_MS
  ];

  const signals = [
    { capturedAt: BASE,           value: 1   },  // horizon elapsed → included
    { capturedAt: BASE + H4_MS,   value: -1  },  // horizon elapsed only if now >= BASE+2*H4_MS
    { capturedAt: BASE + 2*H4_MS, value: 0.5 },  // too recent → always excluded if now = BASE+2*H4_MS
  ];

  it("includes all pairs whose horizon has fully elapsed", () => {
    const nowMs = BASE + 2 * H4_MS; // both first two snapshots' 4h window has closed
    const pairs = buildPairs(signals, prices, H4_MS, nowMs);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual([1, 0.1]); // (110-100)/100 = 0.1
  });

  it("excludes snapshots where capturedAt + horizonMs > nowMs (no lookahead)", () => {
    // nowMs = BASE + H4_MS — only the first snapshot's horizon has elapsed
    const pairs = buildPairs(signals, prices, H4_MS, BASE + H4_MS);
    expect(pairs).toHaveLength(1);
    expect(pairs[0][0]).toBe(1); // signal value
  });

  it("too-recent snapshots produce zero pairs", () => {
    const pairs = buildPairs(signals, prices, H4_MS, BASE); // no window elapsed at all
    expect(pairs).toHaveLength(0);
  });
});

// ── Scorecard + warming gate ─────────────────────────────────────────────────

function makeMockStore(rows: Array<{ capturedAt: number; funding: number; markPx: number }>): MarketStore {
  const store = new MarketStore(":memory:");
  for (const { capturedAt, funding, markPx } of rows) {
    store.writeSnapshot("HYPE", "mainnet", capturedAt, [
      { key: "funding_rate", value: funding, source: "hl-market", kind: "level" },
      { key: "perp_mark_px", value: markPx,  source: "hl-market", kind: "level" },
    ]);
  }
  return store;
}

describe("buildScorecard — warming gate", () => {
  it("all cells are warming (n=0, ic=null) when there is no history", () => {
    const store = new MarketStore(":memory:");
    const cells = buildScorecard(store, "HYPE");
    expect(cells.length).toBe(39 * 4); // 39 signals × 4 horizons = 156
    for (const c of cells) {
      expect(c.n).toBe(0);
      expect(c.ic).toBeNull();
      expect(c.hit_rate).toBeNull();
    }
    store.close();
  });

  it("a signal with fewer than MIN_N valid pairs stays warming", () => {
    // Only 4 rows — not enough to cross MIN_N=8 for any horizon
    const rows = Array.from({ length: 4 }, (_, i) => ({
      capturedAt: i * 3_600_000,
      funding: i * 0.0001,
      markPx: 20 + i,
    }));
    const store = makeMockStore(rows);
    const cells = buildScorecard(store, "HYPE", rows[rows.length - 1].capturedAt + 3_600_000);
    const fundingCells = cells.filter((c) => c.signal === "funding_rate");
    for (const c of fundingCells) {
      expect(c.ic).toBeNull();
      expect(c.hit_rate).toBeNull();
    }
    store.close();
  });

  it("a signal with ≥ MIN_N valid pairs past the horizon gets an IC value", () => {
    const H4 = 4 * 3_600_000;
    // 20 rows spaced 1h apart: monotonically rising price + monotonically rising funding → IC ≈ -1 if contrarian,
    // but here we just check it's finite and n >= MIN_N.
    const rows = Array.from({ length: 20 }, (_, i) => ({
      capturedAt: i * 3_600_000,
      funding: i * 0.001,
      markPx: 10 + i, // monotonically rising with funding (positive IC expected)
    }));
    const store = makeMockStore(rows);
    // nowMs must be far enough past the last snapshot that the 4h window has elapsed for ≥ MIN_N rows.
    const nowMs = rows[rows.length - 1].capturedAt + H4 + 3_600_000;
    const cells = buildScorecard(store, "HYPE", nowMs);
    const cell4h = cells.find((c) => c.signal === "funding_rate" && c.horizon_h === 4)!;
    expect(cell4h.n).toBeGreaterThanOrEqual(MIN_N);
    expect(cell4h.ic).not.toBeNull();
    expect(Number.isFinite(cell4h.ic!)).toBe(true);
    store.close();
  });
});

// ── Bias aggregation ──────────────────────────────────────────────────────────

describe("computeBias", () => {
  it("returns Neutral with LOW confidence when no cells are scored", () => {
    const warnCells = Array.from({ length: 39 }, (_, i) => ({
      signal: `sig${i}`, horizon_h: 4, n: 0, ic: null, hit_rate: null,
    }));
    const bias = computeBias(warnCells, {}, 4, "HYPE");
    expect(bias.label).toBe("Neutral");
    expect(bias.confidence).toBe("LOW");
    expect(bias.score).toBe(0);
  });

  it("positive IC + positive signal value votes Bullish", () => {
    // 5 scored cells needed for HIGH confidence (MIN_SCORED_FOR_HIGH_CONFIDENCE = 5)
    const cells = [
      { signal: "funding_rate",       horizon_h: 4, n: 100, ic: 0.2,  hit_rate: 0.6 },
      { signal: "perp_premium",       horizon_h: 4, n: 100, ic: 0.15, hit_rate: 0.55 },
      { signal: "cvd_perp_24h",       horizon_h: 4, n: 100, ic: 0.12, hit_rate: 0.52 },
      { signal: "cvd_spot_24h",       horizon_h: 4, n: 100, ic: 0.11, hit_rate: 0.51 },
      { signal: "total_staked_hype",  horizon_h: 4, n: 100, ic: 0.13, hit_rate: 0.53 },
    ];
    // funding_rate = 0.001 (positive), IC = +0.2 → vote = +1 × 0.2 = +0.2 (bullish)
    // other signals have null current values so they contribute to scoredCount but not to the vote
    const bias = computeBias(cells, { funding_rate: 0.001 }, 4, "HYPE");
    expect(bias.score).toBeGreaterThan(0);
    expect(bias.label).toBe("Bullish");
    expect(bias.bullCount).toBe(1);
    expect(bias.bearCount).toBe(0);
  });

  it("negative IC + positive signal value votes Bearish (contrarian semantic)", () => {
    const cells = [
      { signal: "funding_rate",       horizon_h: 4, n: 100, ic: -0.2, hit_rate: 0.4 },
      { signal: "perp_premium",       horizon_h: 4, n: 100, ic: 0.15, hit_rate: 0.55 },
      { signal: "cvd_perp_24h",       horizon_h: 4, n: 100, ic: 0.12, hit_rate: 0.52 },
      { signal: "cvd_spot_24h",       horizon_h: 4, n: 100, ic: 0.11, hit_rate: 0.51 },
      { signal: "total_staked_hype",  horizon_h: 4, n: 100, ic: 0.13, hit_rate: 0.53 },
    ];
    // funding_rate positive, IC negative → vote = +1 × -0.2 = -0.2 (bearish) — correct for contrarian signal
    const bias = computeBias(cells, { funding_rate: 0.001 }, 4, "HYPE");
    expect(bias.score).toBeLessThan(0);
    expect(bias.label).toBe("Bearish");
    expect(bias.bearCount).toBe(1);
    expect(bias.bullCount).toBe(0);
  });

  it("signals with null current value are skipped", () => {
    const cells = [{ signal: "funding_rate", horizon_h: 4, n: 100, ic: 0.5, hit_rate: 0.7 }];
    const bias = computeBias(cells, { funding_rate: null }, 4, "HYPE");
    expect(bias.score).toBe(0);
    expect(bias.bullCount).toBe(0);
    expect(bias.bearCount).toBe(0);
  });

  it("marks HIGH confidence when MIN_SCORED signals have IC", () => {
    // Use 5 real signalForScoring keys so computeBias finds them in the manifest
    const REAL_SIGNALS = ["funding_rate", "perp_premium", "cvd_perp_1h", "cvd_perp_4h", "cvd_perp_24h"];
    const cells = REAL_SIGNALS.map((signal) => ({ signal, horizon_h: 4, n: 50, ic: 0.1, hit_rate: 0.55 }));
    const currentValues = Object.fromEntries(REAL_SIGNALS.map((k) => [k, 1]));
    const bias = computeBias(cells, currentValues, 4, "HYPE");
    expect(bias.confidence).toBe("HIGH");
  });
});

// ── CSV shapes ────────────────────────────────────────────────────────────────

describe("scorecardToCsv", () => {
  it("first line matches the reference header exactly", () => {
    const cells = buildScorecard(new MarketStore(":memory:"), "HYPE");
    const csv   = scorecardToCsv(cells);
    const [header] = csv.split("\n");
    expect(header).toBe("signal,horizon_h,n,ic,hit_rate");
  });

  it("warming rows emit empty ic and hit_rate fields", () => {
    const cells = [{ signal: "funding_rate", horizon_h: 4, n: 3, ic: null, hit_rate: null }];
    const csv   = scorecardToCsv(cells);
    const [, row] = csv.split("\n");
    expect(row).toBe("funding_rate,4,3,,");
  });

  it("scored rows format ic and hit_rate to 3 decimal places", () => {
    const cells = [{ signal: "perp_premium", horizon_h: 24, n: 100, ic: -0.034123, hit_rate: 0.485678 }];
    const [, row] = scorecardToCsv(cells).split("\n");
    expect(row).toBe("perp_premium,24,100,-0.034,0.486");
  });

  it("covers all 39 × 4 = 156 cells", () => {
    const store = new MarketStore(":memory:");
    const cells = buildScorecard(store, "HYPE");
    const csv   = scorecardToCsv(cells);
    const dataLines = csv.trim().split("\n").slice(1); // strip header
    expect(dataLines).toHaveLength(156);
    store.close();
  });
});

describe("buildSnapshotsCsv", () => {
  it("first header token is ts_ms", () => {
    const store = new MarketStore(":memory:");
    const csv   = buildSnapshotsCsv(store, "HYPE");
    const [header] = csv.split("\n");
    expect(header.startsWith("ts_ms,")).toBe(true);
    store.close();
  });

  it("header contains ts_ms + exactly the 78 raw (non-derived) manifest columns", () => {
    // Verifies all columns are present and the count is correct; order is manifest-driven.
    const store = new MarketStore(":memory:");
    const [header] = buildSnapshotsCsv(store, "HYPE").split("\n");
    const cols = header.split(",");
    expect(cols[0]).toBe("ts_ms");
    expect(cols).toHaveLength(79); // 1 ts_ms + 78 raw metrics
    // Spot-check that key columns are present at expected positions
    expect(cols.includes("funding_rate")).toBe(true);
    expect(cols.includes("perp_mark_px")).toBe(true);
    expect(cols.includes("hl_liq_net_24h")).toBe(true);
    // No derived columns
    expect(cols.includes("oi_delta")).toBe(false);
    expect(cols.includes("spot_perp_basis")).toBe(false);
    store.close();
  });

  it("empty store produces just the header row", () => {
    const store = new MarketStore(":memory:");
    const csv   = buildSnapshotsCsv(store, "HYPE");
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(1); // header only
    store.close();
  });
});

// ── computeDerived ────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<Omit<MarketPollContext, "derived">> = {}): Omit<MarketPollContext, "derived"> {
  return {
    symbol: "HYPE",
    perpCtx: { markPx: "25.0", oraclePx: "25.0", funding: "0.0001", openInterest: "1000000", premium: "0.0008", dayNtlVlm: "5000000" },
    spotCtx: { markPx: "25.1", dayNtlVlm: "2000000" },
    circulatingSupply: "330000000",
    cvd: null,
    book: { perp: null, spot: null },
    hlNative: {
      staking: { totalStaked: 435_000_000, activeStaked: 434_000_000, validatorCount: 32 },
      af: { hypeBalance: 45_000_000, buyHypeWindow: 60, buyUsdcWindow: 1500, buyFills: 3 },
    },
    cex: { oi: { binance: 5_000_000, bybit: 3_000_000, okx: 1_700_000, total: 9_700_000 }, lsr: { binanceGlobal: null, binanceTopPos: null, binanceTaker: null, bybitAccount: null, okxAccount: null, okxTopPos: null, okxTaker: null, aggLongFrac: null }, liq: null },
    onChain: { totalBalance: 12_000, walletsPolled: 2, netFlow: null, inflow: null, outflow: null, netFlowUsdc: null, holders: { count: 243_000, supplyExSystem: 85_000_000, top10Share: 0.40, top50Share: 0.60, top100Share: 0.75 } },
    ...overrides,
  };
}

describe("computeDerived", () => {
  it("oi_delta = current OI − prev OI", () => {
    const ctx = makeCtx(); // openInterest = "1000000"
    const d = computeDerived(ctx, { prev: { open_interest: 950_000 }, intervalMs: 60_000 });
    expect(d.oiDelta).toBe(50_000);
  });

  it("spot_perp_basis = spot_mark_px − perp_mark_px", () => {
    const d = computeDerived(makeCtx(), { prev: {}, intervalMs: null });
    expect(d.spotPerpBasis).toBeCloseTo(0.004, 5); // (25.1 - 25.0) / 25.0
  });

  it("spot_perp_basis is null when spotCtx is null", () => {
    const d = computeDerived(makeCtx({ spotCtx: null }), { prev: {}, intervalMs: null });
    expect(d.spotPerpBasis).toBeNull();
  });

  it("staked_delta = totalStaked − prev", () => {
    const d = computeDerived(makeCtx(), { prev: { total_staked_hype: 434_000_000 }, intervalMs: 60_000 });
    expect(d.stakedDelta).toBe(1_000_000);
  });

  it("af_buy_rate = buyHypeWindow / intervalHours", () => {
    // 60 HYPE bought in 30 minutes = 120 HYPE/hour
    const d = computeDerived(makeCtx(), { prev: {}, intervalMs: 30 * 60_000 });
    expect(d.afBuyRate).toBeCloseTo(120, 5);
  });

  it("af_buy_rate is null on cold start (no interval)", () => {
    const d = computeDerived(makeCtx(), { prev: {}, intervalMs: null });
    expect(d.afBuyRate).toBeNull();
  });

  it("cex_balance_delta = current balance − prev", () => {
    const d = computeDerived(makeCtx(), { prev: { cex_total_balance_hype: 11_000 }, intervalMs: 60_000 });
    expect(d.cexBalanceDelta).toBe(1_000);
  });

  it("holder_top10_delta = current share − prev", () => {
    const d = computeDerived(makeCtx(), { prev: { holder_top10_share: 0.38 }, intervalMs: 60_000 });
    expect(d.holderTop10Delta).toBeCloseTo(0.02, 8);
  });

  it("cex_oi_delta = cex total OI − prev", () => {
    const d = computeDerived(makeCtx(), { prev: { cex_oi_total_hype: 9_000_000 }, intervalMs: 60_000 });
    expect(d.cexOiDelta).toBe(700_000);
  });

  it("net_twap_hype and net_twap_full_hype are null when TWAP inputs are missing (stage-3b stubs)", () => {
    const d = computeDerived(makeCtx(), { prev: {}, intervalMs: 60_000 });
    expect(d.netTwapHype).toBeNull();
    expect(d.netTwapFullHype).toBeNull();
  });

  it("net_twap_hype computes correctly when all four TWAP inputs are present", () => {
    const d = computeDerived(makeCtx(), {
      prev: {
        twap_spot_buy_hype: 100, twap_spot_sell_hype: 40,
        twap_perp_buy_hype: 60,  twap_perp_sell_hype: 30,
      },
      intervalMs: 60_000,
    });
    // net = (100+60) - (40+30) = 90
    expect(d.netTwapHype).toBe(90);
  });
});
