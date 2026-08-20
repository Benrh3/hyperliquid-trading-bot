// Canary: rollup ts_hour capturedAt must label the END of the bucket, not the
// start. A rollup row for bucket [H, H+HOUR_MS) must never be assigned to a
// candle that closed at H — doing so reads data collected up to 59 min later.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { MarketStore } from "../market/store.js";
import { attachSignals, type SignalTimeSeries } from "../backtest.js";

const HOUR_MS = 3_600_000;
// Anchor: 2026-01-10T14:00:00Z — bucket covers [14:00, 14:59]
const H = new Date("2026-01-10T14:00:00Z").getTime();

let tmpPath: string;
let store: MarketStore;
let direct: Database.Database;

beforeAll(() => {
  tmpPath = join(tmpdir(), `rollup-canary-${Date.now()}.db`);
  store  = new MarketStore(tmpPath);
  direct = new Database(tmpPath);
  // Insert a rollup row whose avg_value would fire FundingExtreme (extreme funding)
  direct.prepare(`
    INSERT OR IGNORE INTO snapshot_metrics_hourly
      (ts_hour, symbol, metric_key, avg_value, source, kind, sample_count)
    VALUES (?, 'HYPE', 'funding_rate', 1e-4, 'hl-meta', 'funding', 5)
  `).run(H);
});

afterAll(() => {
  direct.close();
  store.close();
  rmSync(tmpPath, { force: true });
});

describe("rollup-timestamp canary", () => {
  it("getMetricTimeSeries returns ts_hour + HOUR_MS as capturedAt, not ts_hour", () => {
    const series = store.getMetricTimeSeries("HYPE", "funding_rate");
    expect(series).toHaveLength(1);
    expect(series[0]!.capturedAt).toBe(H + HOUR_MS);   // 15:00, not 14:00
    expect(series[0]!.value).toBeCloseTo(1e-4);
  });

  it("rollup bucket does NOT contaminate the candle that closed at ts_hour", () => {
    // Bucket [14:00, 14:59] has capturedAt = 15:00 after the fix.
    //
    // Candle 13:00 → closeTime = 14:00.
    //   OLD (capturedAt = ts_hour = 14:00): 14:00 ≤ 14:00 → bucket assigned  ← bug
    //   NEW (capturedAt = ts_hour+HOUR_MS = 15:00): 15:00 > 14:00 → excluded ← fix
    //
    // Candle 14:00 → closeTime = 15:00.
    //   capturedAt = 15:00 ≤ 15:00 → bucket assigned.
    //   Correct: fill happens at 15:00 open; all bucket samples predate that.
    const candles = [
      { timestamp: H - HOUR_MS, open: 1, high: 1, low: 1, close: 1, volume: 0 }, // 13:00
      { timestamp: H,           open: 1, high: 1, low: 1, close: 1, volume: 0 }, // 14:00
      { timestamp: H + HOUR_MS, open: 1, high: 1, low: 1, close: 1, volume: 0 }, // 15:00
    ];

    const series = store.getMetricTimeSeries("HYPE", "funding_rate");
    const sigMap = new Map<string, ReadonlyArray<SignalTimeSeries>>([
      ["funding_rate", series],
    ]);
    attachSignals(candles, sigMap);

    const candleAt13 = candles.find(c => c.timestamp === H - HOUR_MS)!;
    const candleAt14 = candles.find(c => c.timestamp === H)!;
    const candleAt15 = candles.find(c => c.timestamp === H + HOUR_MS)!;

    // 13:00 closes at 14:00 — bucket [14:00,14:59] data not yet available → null
    expect((candleAt13 as any).signals?.["funding_rate"]).toBeNull();
    // 14:00 closes at 15:00 — bucket fully available by 15:00 → signal correct ✓
    expect((candleAt14 as any).signals?.["funding_rate"]).toBeCloseTo(1e-4);
    // 15:00 closes at 16:00 — carry-forward ✓
    expect((candleAt15 as any).signals?.["funding_rate"]).toBeCloseTo(1e-4);
  });

  it("raw snapshot_metrics capturedAt is passed through unchanged", () => {
    // Raw rows use the actual poll timestamp — no offset should be applied.
    // Insert a snapshot + metric row with a known captured_at, then verify
    // getMetricTimeSeries returns that exact timestamp.
    const rawCapturedAt = H + HOUR_MS; // 15:00
    const snapId = (direct.prepare(
      "INSERT INTO snapshots (symbol, network, captured_at) VALUES ('HYPE', 'mainnet', ?)"
    ).run(rawCapturedAt)).lastInsertRowid as number;
    direct.prepare(`
      INSERT INTO snapshot_metrics (snapshot_id, metric_key, value, source, kind, captured_at)
      VALUES (?, 'funding_rate', 2e-5, 'hl-meta', 'funding', ?)
    `).run(snapId, rawCapturedAt);

    const series = store.getMetricTimeSeries("HYPE", "funding_rate");
    // Expect 2 rows: the hourly (capturedAt = H+HOUR_MS = 15:00) and the raw
    // (capturedAt = 15:00). The hourly is filtered out when raw starts at
    // ts_hour + HOUR_MS <= MIN(raw), i.e. H+HOUR_MS <= H+HOUR_MS → kept.
    // Both have capturedAt = 15:00 so both should appear.
    const rawRow = series.find(r => r.value !== null && Math.abs(r.value - 2e-5) < 1e-10);
    expect(rawRow).toBeDefined();
    expect(rawRow!.capturedAt).toBe(rawCapturedAt);
  });
});
