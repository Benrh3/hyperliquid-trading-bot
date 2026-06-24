import { describe, it, expect } from "vitest";
import { CvdTracker, BUCKET_MS, WINDOW_1H_BUCKETS, WINDOW_24H_BUCKETS, type CvdTrackerSnapshot } from "../market/tradesAggregator.js";

describe("CvdTracker persistence", () => {
  it("snapshot + rehydrate restores buckets and windows", () => {
    const T0 = 1700000000000;
    let clock = T0;
    const now = function () { return clock; };

    const tracker = new CvdTracker(now);

    // Record trades spanning 2 hours
    for (let m = 0; m < 120; m++) {
      clock = T0 + m * BUCKET_MS;
      tracker.recordTrade("B", 10, clock);
      tracker.recordTrade("A", 3, clock);
    }
    clock = T0 + 120 * BUCKET_MS;

    const before = tracker.getWindows();
    expect(before.cvd1h).toBeGreaterThan(0);
    expect(before.trades24h).toBe(240);
    expect(before.filled1h).toBe(1);

    // Snapshot
    const snap = tracker.snapshot();
    expect(snap.buckets.length).toBe(120);

    // Create a NEW tracker (simulates restart) and rehydrate
    const tracker2 = new CvdTracker(now);
    tracker2.rehydrate(snap);

    const after = tracker2.getWindows();
    expect(after.cvd1h).toBe(before.cvd1h);
    expect(after.cvd24h).toBe(before.cvd24h);
    expect(after.trades24h).toBe(before.trades24h);
    // Filled fraction should be 1.0 (bootTime was restored)
    expect(after.filled1h).toBe(1);
  });

  it("rehydrated tracker does not double-count live trades", () => {
    const T0 = 1700000000000;
    let clock = T0;
    const now = function () { return clock; };

    const tracker = new CvdTracker(now);
    clock = T0 + 10 * BUCKET_MS;
    tracker.recordTrade("B", 100, T0 + 5 * BUCKET_MS);

    const snap = tracker.snapshot();

    // Simulate restart
    const tracker2 = new CvdTracker(now);
    tracker2.rehydrate(snap);

    // Add a NEW trade at a different time (no overlap)
    clock = T0 + 20 * BUCKET_MS;
    tracker2.recordTrade("B", 50, T0 + 15 * BUCKET_MS);

    const w = tracker2.getWindows();
    // Should be 100 + 50 = 150, not 200 (no double-count)
    expect(w.cvd24h).toBe(150);
    expect(w.trades24h).toBe(2);
  });

  it("rehydrate with stale buckets evicts old data", () => {
    const T0 = 1700000000000;
    let clock = T0;
    const now = function () { return clock; };

    const tracker = new CvdTracker(now);
    tracker.recordTrade("B", 100, T0);

    const snap = tracker.snapshot();

    // Simulate restart 25h later — the old bucket is stale
    clock = T0 + 25 * 3600000;
    const tracker2 = new CvdTracker(now);
    tracker2.rehydrate(snap);

    const w = tracker2.getWindows();
    // Stale bucket evicted — CVD should be 0
    expect(w.cvd24h).toBe(0);
    expect(w.trades24h).toBe(0);
  });

  it("fresh tracker with no rehydration starts empty", () => {
    const tracker = new CvdTracker();
    const w = tracker.getWindows();
    expect(w.cvd1h).toBe(0);
    expect(w.cvd24h).toBe(0);
    expect(w.trades24h).toBe(0);
  });
});
