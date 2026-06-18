/**
 * Tests for CexLiqTracker (bucketing, window roll-off, filled fractions),
 * the per-venue liquidation parsers, and ReconnectingLiqStream's WS-drop
 * recovery. No live network calls.
 */

import { describe, it, expect, vi } from "vitest";
import { CexLiqTracker, LIQ_BUCKET_MS, LIQ_WINDOW_1H_BUCKETS, LIQ_WINDOW_24H_BUCKETS } from "../market/cex/liqTracker.js";
import { parseBinanceForceOrder, parseBybitAllLiquidation, parseOkxLiquidationOrders } from "../market/cex/parsers.js";
import { ReconnectingLiqStream, type LiqStreamConnector, type LiqStreamConnection } from "../market/cex/wsLiqStream.js";

describe("CexLiqTracker", () => {
  it("buckets long (forced-sell) and short (forced-buy) volume separately", () => {
    let now = 0;
    const tracker = new CexLiqTracker(() => now);

    tracker.recordLiq("long", 10, now);
    tracker.recordLiq("short", 4, now);
    tracker.recordLiq("long", 2, now);

    const windows = tracker.getWindows();
    expect(windows.longVol1h).toBe(12);
    expect(windows.shortVol1h).toBe(4);
    expect(windows.count1h).toBe(3);
    expect(windows.longVol24h).toBe(12);
    expect(windows.shortVol24h).toBe(4);
    expect(windows.count24h).toBe(3);
  });

  it("rolls volume older than a window off the windowed sums", () => {
    let now = 0;
    const tracker = new CexLiqTracker(() => now);

    // A long liquidation of size 100 in minute 0.
    tracker.recordLiq("long", 100, now);

    // Advance 61 minutes — older than the 1h (60-bucket) window.
    now += 61 * LIQ_BUCKET_MS;
    tracker.recordLiq("long", 1, now);

    const windows = tracker.getWindows();
    expect(windows.longVol1h).toBe(1);    // the size-100 liq rolled off
    expect(windows.longVol24h).toBe(101); // still within 24h
    expect(windows.count1h).toBe(1);
    expect(windows.count24h).toBe(2);
  });

  it("evicts buckets older than 24h from the ring entirely", () => {
    let now = 0;
    const tracker = new CexLiqTracker(() => now);

    tracker.recordLiq("long", 50, now);

    // Advance past the 24h window.
    now += (LIQ_WINDOW_24H_BUCKETS + 1) * LIQ_BUCKET_MS;
    tracker.recordLiq("short", 1, now);

    const windows = tracker.getWindows();
    expect(windows.longVol24h).toBe(0);
    expect(windows.shortVol24h).toBe(1);
    expect(windows.count24h).toBe(1);
  });

  it("reports filled fractions proportional to elapsed time since boot", () => {
    let now = 0;
    const tracker = new CexLiqTracker(() => now);
    expect(tracker.getWindows().filled1h).toBeCloseTo(1 / LIQ_WINDOW_1H_BUCKETS, 5);
    expect(tracker.getWindows().filled24h).toBeCloseTo(1 / LIQ_WINDOW_24H_BUCKETS, 5);

    now = 30 * LIQ_BUCKET_MS;
    expect(tracker.getWindows().filled1h).toBeCloseTo(31 / LIQ_WINDOW_1H_BUCKETS, 5);

    now = LIQ_WINDOW_24H_BUCKETS * LIQ_BUCKET_MS;
    expect(tracker.getWindows().filled1h).toBe(1);
    expect(tracker.getWindows().filled24h).toBe(1);
  });
});

describe("parseBinanceForceOrder", () => {
  it("parses a SELL forceOrder as a long liquidation with notional", () => {
    const event = parseBinanceForceOrder({
      e: "forceOrder",
      E: 1700000000000,
      o: { S: "SELL", q: "12.5", p: "73.5", T: 1700000000123 },
    });
    expect(event).toEqual({ side: "long", qtyCoins: 12.5, notionalUsd: 12.5 * 73.5, timeMs: 1700000000123 });
  });

  it("parses a BUY forceOrder as a short liquidation", () => {
    const event = parseBinanceForceOrder({
      e: "forceOrder",
      E: 1700000000000,
      o: { S: "BUY", q: "3", p: "74.0", T: 1700000000456 },
    });
    expect(event?.side).toBe("short");
    expect(event?.notionalUsd).toBe(3 * 74);
  });

  it("returns null for non-forceOrder or malformed messages", () => {
    expect(parseBinanceForceOrder({ e: "trade" })).toBeNull();
    expect(parseBinanceForceOrder({ e: "forceOrder" })).toBeNull();
    expect(parseBinanceForceOrder({ e: "forceOrder", o: { S: "SELL", q: "not-a-number", T: 1 } })).toBeNull();
    expect(parseBinanceForceOrder(null)).toBeNull();
    expect(parseBinanceForceOrder("garbage")).toBeNull();
  });
});

describe("parseBybitAllLiquidation", () => {
  it("parses a batch of Sell/Buy liquidations as long/short", () => {
    const events = parseBybitAllLiquidation({
      topic: "allLiquidation.HYPEUSDT",
      data: [
        { S: "Sell", v: "10", p: "73.5", T: 1700000000000 },
        { S: "Buy", v: "5", p: "74.0", T: 1700000000111 },
      ],
    });
    expect(events).toEqual([
      { side: "long", qtyCoins: 10, notionalUsd: 735, timeMs: 1700000000000 },
      { side: "short", qtyCoins: 5, notionalUsd: 370, timeMs: 1700000000111 },
    ]);
  });

  it("returns an empty array for non-matching topics or malformed messages", () => {
    expect(parseBybitAllLiquidation({ topic: "trade.HYPEUSDT", data: [] })).toEqual([]);
    expect(parseBybitAllLiquidation({ topic: "allLiquidation.HYPEUSDT" })).toEqual([]);
    expect(parseBybitAllLiquidation(null)).toEqual([]);
    expect(parseBybitAllLiquidation({ topic: "allLiquidation.HYPEUSDT", data: [{ S: "Sell", v: "bad", p: "73", T: 1 }] })).toEqual([]);
  });
});

describe("parseOkxLiquidationOrders", () => {
  const instId = "HYPE-USDT-SWAP";
  const ctVal = 0.1;

  it("converts contract sizes to coin units via ctVal and maps sell/buy to long/short", () => {
    const events = parseOkxLiquidationOrders(
      {
        arg: { channel: "liquidation-orders" },
        data: [
          {
            instId,
            details: [
              { side: "sell", sz: "100", bkPx: "73.5", ts: "1700000000000" },
              { side: "buy", sz: "50", bkPx: "74.0", ts: "1700000000222" },
            ],
          },
        ],
      },
      instId,
      ctVal,
    );
    expect(events).toEqual([
      { side: "long", qtyCoins: 10, notionalUsd: 10 * 73.5, timeMs: 1700000000000 },
      { side: "short", qtyCoins: 5, notionalUsd: 5 * 74.0, timeMs: 1700000000222 },
    ]);
  });

  it("ignores entries for other instruments and non-liquidation channels", () => {
    expect(
      parseOkxLiquidationOrders(
        { arg: { channel: "liquidation-orders" }, data: [{ instId: "BTC-USDT-SWAP", details: [{ side: "sell", sz: "1", ts: "1" }] }] },
        instId,
        ctVal,
      ),
    ).toEqual([]);

    expect(
      parseOkxLiquidationOrders({ arg: { channel: "other" }, data: [] }, instId, ctVal),
    ).toEqual([]);

    expect(parseOkxLiquidationOrders(null, instId, ctVal)).toEqual([]);
  });
});

describe("ReconnectingLiqStream", () => {
  it("survives a simulated WS drop, preserving prior state and resuming without crashing", async () => {
    const tracker = new CexLiqTracker();
    let onMessageCapture: ((raw: unknown) => void) | null = null;
    let failNext = false;

    const connector: LiqStreamConnector = vi.fn().mockImplementation(async (onMessage: (raw: unknown) => void): Promise<LiqStreamConnection> => {
      if (failNext) throw new Error("WS connection dropped");
      onMessageCapture = onMessage;
      return { close: () => {} };
    });

    const stream = new ReconnectingLiqStream("cex-test", connector, (raw) => {
      const event = parseBinanceForceOrder(raw);
      if (event) tracker.recordLiq(event.side, event.notionalUsd, event.timeMs);
    });

    stream.start();
    await (stream as unknown as { connect(): Promise<void> }).connect();

    // Record an event before the drop (10 coins @ $73.5 = $735 notional).
    onMessageCapture!({ e: "forceOrder", o: { S: "SELL", q: "10", p: "73.5", T: Date.now() } });
    expect(tracker.getWindows().longVol1h).toBe(735);

    // Simulate a drop: connect() throws once.
    failNext = true;
    await expect((stream as unknown as { connect(): Promise<void> }).connect()).resolves.toBeUndefined();

    // Existing data survives the failed reconnect attempt.
    expect(tracker.getWindows().longVol1h).toBe(735);

    // Recover: next reconnect succeeds and new events continue to accumulate.
    failNext = false;
    await (stream as unknown as { connect(): Promise<void> }).connect();
    onMessageCapture!({ e: "forceOrder", o: { S: "SELL", q: "5", p: "73.5", T: Date.now() } });
    expect(tracker.getWindows().longVol1h).toBe(735 + 5 * 73.5);

    stream.stop();
  });
});
