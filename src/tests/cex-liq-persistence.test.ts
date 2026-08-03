import { describe, it, expect } from "vitest";
import { CexLiqTracker, LIQ_BUCKET_MS, LIQ_WINDOW_1H_BUCKETS, LIQ_WINDOW_24H_BUCKETS, type CexLiqTrackerSnapshot } from "../market/cex/liqTracker.js";

describe("CexLiqTracker persistence", () => {
  it("snapshot + rehydrate restores buckets and windows", () => {
    const T0 = 1700000000000;
    let clock = T0;
    const now = function () { return clock; };

    const tracker = new CexLiqTracker(now);

    // Record liquidations spanning 2 hours
    for (let m = 0; m < 120; m++) {
      clock = T0 + m * LIQ_BUCKET_MS;
      tracker.recordLiq("long", 10, clock);
      tracker.recordLiq("short", 3, clock);
    }
    clock = T0 + 120 * LIQ_BUCKET_MS;

    const before = tracker.getWindows();
    expect(before.longVol1h).toBeGreaterThan(0);
    expect(before.count24h).toBe(240);
    expect(before.filled1h).toBe(1);

    const snap = tracker.snapshot();
    expect(snap.buckets.length).toBe(120);

    // Simulate a restart: brand new tracker, rehydrated from the snapshot.
    const tracker2 = new CexLiqTracker(now);
    tracker2.rehydrate(snap);

    const after = tracker2.getWindows();
    expect(after.longVol1h).toBe(before.longVol1h);
    expect(after.longVol24h).toBe(before.longVol24h);
    expect(after.shortVol24h).toBe(before.shortVol24h);
    expect(after.count24h).toBe(before.count24h);
    // Filled fraction should be 1.0 — bootTime was restored, not reset.
    // (Only 2h of data was recorded above, so filled24h is not yet 1 — that's
    // covered separately by the "long-lived snapshot" test below.)
    expect(after.filled1h).toBe(1);
  });

  it("rehydrated tracker does not double-count live events", () => {
    const T0 = 1700000000000;
    let clock = T0;
    const now = function () { return clock; };

    const tracker = new CexLiqTracker(now);
    clock = T0 + 10 * LIQ_BUCKET_MS;
    tracker.recordLiq("long", 100, T0 + 5 * LIQ_BUCKET_MS);

    const snap = tracker.snapshot();

    const tracker2 = new CexLiqTracker(now);
    tracker2.rehydrate(snap);

    clock = T0 + 20 * LIQ_BUCKET_MS;
    tracker2.recordLiq("long", 50, T0 + 15 * LIQ_BUCKET_MS);

    const w = tracker2.getWindows();
    expect(w.longVol24h).toBe(150); // 100 + 50, not double-counted
    expect(w.count24h).toBe(2);
  });

  it("rehydrate with stale buckets evicts data older than the 24h window", () => {
    const T0 = 1700000000000;
    let clock = T0;
    const now = function () { return clock; };

    const tracker = new CexLiqTracker(now);
    tracker.recordLiq("long", 100, T0);

    const snap = tracker.snapshot();

    // Simulate a restart 25h later — the old bucket is stale.
    clock = T0 + 25 * 3600000;
    const tracker2 = new CexLiqTracker(now);
    tracker2.rehydrate(snap);

    const w = tracker2.getWindows();
    expect(w.longVol24h).toBe(0);
    expect(w.count24h).toBe(0);
  });

  it("fresh tracker with no rehydration starts empty and cold", () => {
    const tracker = new CexLiqTracker();
    const w = tracker.getWindows();
    expect(w.longVol1h).toBe(0);
    expect(w.longVol24h).toBe(0);
    expect(w.count24h).toBe(0);
    expect(w.filled24h).toBeLessThan(1);
  });

  it("rehydrating from a long-lived snapshot immediately reports full filled fractions", () => {
    // bootTime far in the past — as if the tracker has been running for days,
    // persisted, and is now being restored across a restart.
    const T0 = 1700000000000;
    const snap: CexLiqTrackerSnapshot = {
      bootTime: T0 - 7 * 24 * 3600000,
      buckets: [{ bucketStart: T0 - LIQ_BUCKET_MS, longVol: 500, shortVol: 20, count: 4 }],
    };
    const tracker = new CexLiqTracker(() => T0);
    tracker.rehydrate(snap);

    const w = tracker.getWindows();
    expect(w.filled1h).toBe(1);
    expect(w.filled24h).toBe(1);
    expect(w.longVol1h).toBe(500);

    // Sanity: the constants are what the test assumes.
    expect(LIQ_WINDOW_1H_BUCKETS).toBe(60);
    expect(LIQ_WINDOW_24H_BUCKETS).toBe(1440);
  });
});
