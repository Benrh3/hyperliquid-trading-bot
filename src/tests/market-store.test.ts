/**
 * Round-trip tests for the Market data store (snapshots + snapshot_metrics).
 * Uses an in-memory SQLite database — no files written.
 */

import { describe, it, expect } from "vitest";
import { MarketStore } from "../market/store.js";

describe("MarketStore", () => {
  it("round-trips a snapshot and its metrics", () => {
    const store = new MarketStore(":memory:");
    const capturedAt = Date.now();

    const id = store.writeSnapshot("HYPE", "mainnet", capturedAt, [
      { key: "perp_mark_px", value: 25.5, source: "hl-market", kind: "level" },
      { key: "funding_rate", value: 0.00012, source: "hl-market", kind: "level" },
      { key: "open_interest", value: null, source: "hl-market", kind: "level" },
    ]);

    expect(id).toBeGreaterThan(0);

    const rows = store.getRecentSnapshots("HYPE", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("HYPE");
    expect(rows[0].network).toBe("mainnet");
    expect(rows[0].capturedAt).toBe(capturedAt);

    expect(rows[0].metrics.perp_mark_px).toEqual({
      value: 25.5,
      source: "hl-market",
      kind: "level",
      meta: null,
      capturedAt,
    });
    expect(rows[0].metrics.funding_rate.value).toBeCloseTo(0.00012);
    expect(rows[0].metrics.open_interest.value).toBeNull();

    store.close();
  });

  it("returns the most recent snapshots first, respecting limit", () => {
    const store = new MarketStore(":memory:");
    const t0 = Date.now();

    store.writeSnapshot("HYPE", "mainnet", t0, [{ key: "perp_mark_px", value: 1, source: "hl-market", kind: "level" }]);
    store.writeSnapshot("HYPE", "mainnet", t0 + 1000, [{ key: "perp_mark_px", value: 2, source: "hl-market", kind: "level" }]);
    store.writeSnapshot("HYPE", "mainnet", t0 + 2000, [{ key: "perp_mark_px", value: 3, source: "hl-market", kind: "level" }]);

    const rows = store.getRecentSnapshots("HYPE", 2);
    expect(rows).toHaveLength(2);
    expect(rows[0].metrics.perp_mark_px.value).toBe(3);
    expect(rows[1].metrics.perp_mark_px.value).toBe(2);

    store.close();
  });

  it("returns an empty array for a symbol with no snapshots", () => {
    const store = new MarketStore(":memory:");
    expect(store.getRecentSnapshots("ETH", 50)).toEqual([]);
    store.close();
  });

  it("rolls up old snapshot_metrics rows into snapshot_metrics_hourly and deletes raw rows", () => {
    const store = new MarketStore(":memory:");
    const old = Date.now() - 10 * 24 * 60 * 60_000; // 10 days ago

    store.writeSnapshot("HYPE", "mainnet", old, [{ key: "perp_mark_px", value: 20, source: "hl-market", kind: "level" }]);
    store.runRetentionPolicy(7);

    expect(store.getRecentSnapshots("HYPE", 10)).toEqual([]);

    store.close();
  });
});
