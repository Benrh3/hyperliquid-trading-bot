/**
 * Tests for CvdTracker and TradesAggregator — no live network calls.
 * Verifies signed CVD windowing, bucket roll-off, and WS-drop resilience.
 */

import { describe, it, expect, vi } from "vitest";
import { CvdTracker, TradesAggregator, BUCKET_MS, type TradesSubscriptionClient } from "../market/tradesAggregator.js";

describe("CvdTracker", () => {
  it("produces correctly signed CVD and trade counts within a window", () => {
    let now = 0;
    const tracker = new CvdTracker(() => now);

    // Two buys (+10, +5) and one sell (-3) in the same minute bucket.
    tracker.recordTrade("B", 10, now);
    tracker.recordTrade("B", 5, now);
    tracker.recordTrade("A", 3, now);

    const windows = tracker.getWindows();
    expect(windows.cvd1h).toBe(12); // 10 + 5 - 3
    expect(windows.cvd4h).toBe(12);
    expect(windows.cvd24h).toBe(12);
    expect(windows.trades24h).toBe(3);
  });

  it("asserts the buy/sell sign convention: 'B' is positive, 'A' is negative", () => {
    let now = 0;
    const tracker = new CvdTracker(() => now);
    tracker.recordTrade("B", 100, now);
    expect(tracker.getWindows().cvd1h).toBe(100);

    const tracker2 = new CvdTracker(() => now);
    tracker2.recordTrade("A", 100, now);
    expect(tracker2.getWindows().cvd1h).toBe(-100);
  });

  it("rolls trades older than a window off the windowed sum", () => {
    let now = 0;
    const tracker = new CvdTracker(() => now);

    // One buy of size 100 in minute 0.
    tracker.recordTrade("B", 100, now);

    // Advance 61 minutes — older than the 1h (60-bucket) window.
    now += 61 * BUCKET_MS;
    tracker.recordTrade("B", 1, now);

    const windows = tracker.getWindows();
    expect(windows.cvd1h).toBe(1);   // the size-100 trade rolled off
    expect(windows.cvd4h).toBe(101); // still within 4h
    expect(windows.cvd24h).toBe(101);
  });

  it("reports filled fractions proportional to elapsed time since boot", () => {
    let now = 0;
    const tracker = new CvdTracker(() => now);
    expect(tracker.getWindows().filled1h).toBeCloseTo(1 / 60, 5);

    now = 30 * BUCKET_MS;
    expect(tracker.getWindows().filled1h).toBeCloseTo(31 / 60, 5);
    expect(tracker.getWindows().filled24h).toBeCloseTo(31 / 1440, 5);

    now = 24 * 60 * BUCKET_MS;
    expect(tracker.getWindows().filled24h).toBe(1);
    expect(tracker.getWindows().filled1h).toBe(1);
  });
});

describe("TradesAggregator", () => {
  function makeMockClient() {
    const listeners = new Map<string, (data: { side: "B" | "A"; px: string; sz: string; time: number }[]) => void>();
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const client: TradesSubscriptionClient = {
      trades: vi.fn().mockImplementation(async (params: { coin: string }, listener) => {
        listeners.set(params.coin, listener);
        return { unsubscribe };
      }),
    };
    return { client, listeners, unsubscribe };
  }

  it("subscribes to both the perp coin and the resolved spot coin", async () => {
    const { client, listeners } = makeMockClient();
    const agg = new TradesAggregator("HYPE", "@107", client);
    await agg.start();

    expect(client.trades).toHaveBeenCalledWith({ coin: "HYPE" }, expect.any(Function));
    expect(client.trades).toHaveBeenCalledWith({ coin: "@107" }, expect.any(Function));
    expect(listeners.has("HYPE")).toBe(true);
    expect(listeners.has("@107")).toBe(true);

    await agg.stop();
  });

  it("feeds incoming trades into per-coin CVD windows", async () => {
    const { client, listeners } = makeMockClient();
    const agg = new TradesAggregator("HYPE", "@107", client);
    await agg.start();

    listeners.get("HYPE")!([{ side: "B", px: "25.5", sz: "10", time: Date.now() }]);
    listeners.get("@107")!([{ side: "A", px: "25.4", sz: "4", time: Date.now() }]);

    expect(agg.getPerpWindows().cvd1h).toBe(10);
    expect(agg.getSpotWindows()!.cvd1h).toBe(-4);

    await agg.stop();
  });

  it("returns null spot windows when no spot coin was resolved", async () => {
    const { client } = makeMockClient();
    const agg = new TradesAggregator("HYPE", null, client);
    await agg.start();

    expect(agg.getSpotWindows()).toBeNull();
    expect(client.trades).toHaveBeenCalledTimes(1);

    await agg.stop();
  });

  it("survives a simulated WS drop, preserving existing buckets and resuming without crashing", async () => {
    const listeners = new Map<string, (data: { side: "B" | "A"; px: string; sz: string; time: number }[]) => void>();
    const unsubscribe = vi.fn().mockResolvedValue(undefined);

    let failNext = false;
    const client: TradesSubscriptionClient = {
      trades: vi.fn().mockImplementation(async (params: { coin: string }, listener) => {
        if (failNext) throw new Error("WS connection dropped");
        listeners.set(params.coin, listener);
        return { unsubscribe };
      }),
    };

    const agg = new TradesAggregator("HYPE", null, client);
    await agg.start();

    // Record a trade before the drop.
    listeners.get("HYPE")!([{ side: "B", px: "25.5", sz: "10", time: Date.now() }]);
    expect(agg.getPerpWindows().cvd1h).toBe(10);

    // Simulate a drop: connect() throws once.
    failNext = true;
    await expect((agg as unknown as { connect(): Promise<void> }).connect()).resolves.toBeUndefined();

    // Existing data survives the failed reconnect attempt.
    expect(agg.getPerpWindows().cvd1h).toBe(10);

    // Recover: next reconnect succeeds and new trades continue to accumulate.
    failNext = false;
    await (agg as unknown as { connect(): Promise<void> }).connect();
    listeners.get("HYPE")!([{ side: "B", px: "25.5", sz: "5", time: Date.now() }]);
    expect(agg.getPerpWindows().cvd1h).toBe(15);

    await agg.stop();
  });
});
