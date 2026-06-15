/**
 * Tests for L2 book microstructure math — no network calls.
 */

import { describe, it, expect } from "vitest";
import { computePerpBookMetrics, computeSpotBookMetrics, type L2BookLike } from "../market/book.js";

function level(px: string, sz: string) {
  return { px, sz };
}

describe("computePerpBookMetrics", () => {
  it("computes mid, spread_bps, depths, and a known imbalance", () => {
    const book: L2BookLike = {
      levels: [
        [level("99", "10"), level("98", "10")],   // bids: depth 20
        [level("101", "30"), level("102", "30")], // asks: depth 60
      ],
    };

    const m = computePerpBookMetrics(book)!;
    expect(m.mid).toBe(100); // (99 + 101) / 2
    expect(m.spreadBps).toBeCloseTo(((101 - 99) / 100) * 1e4, 5); // 200 bps
    expect(m.bidDepth).toBe(20);
    expect(m.askDepth).toBe(60);

    // imbalance = (20 - 60) / (20 + 60) = -0.5
    expect(m.imbalance).toBeCloseTo(-0.5, 10);
    expect(m.imbalance).toBeGreaterThanOrEqual(-1);
    expect(m.imbalance).toBeLessThanOrEqual(1);
  });

  it("produces an imbalance of -0.35 for a known bid/ask depth ratio", () => {
    // (bidDepth - askDepth) / (bidDepth + askDepth) = -0.35
    // pick bidDepth = 32.5, askDepth = 67.5 -> (32.5-67.5)/100 = -0.35
    const book: L2BookLike = {
      levels: [
        [level("99", "32.5")],
        [level("101", "67.5")],
      ],
    };
    const m = computePerpBookMetrics(book)!;
    expect(m.imbalance).toBeCloseTo(-0.35, 10);
  });

  it("only sums the top `depth` levels per side", () => {
    const bids = Array.from({ length: 25 }, (_, i) => level(String(100 - i), "1"));
    const asks = Array.from({ length: 25 }, (_, i) => level(String(101 + i), "1"));
    const book: L2BookLike = { levels: [bids, asks] };

    const m = computePerpBookMetrics(book, 20)!;
    expect(m.bidDepth).toBe(20);
    expect(m.askDepth).toBe(20);
  });

  it("returns null when a side of the book is empty", () => {
    expect(computePerpBookMetrics({ levels: [[], [level("101", "1")]] })).toBeNull();
    expect(computePerpBookMetrics({ levels: [[level("99", "1")], []] })).toBeNull();
    expect(computePerpBookMetrics(null)).toBeNull();
  });
});

describe("computeSpotBookMetrics", () => {
  it("resolves spot spread/imbalance from the @-coin book passed in, independent of the perp book", () => {
    const perpBook: L2BookLike = {
      levels: [[level("99", "10")], [level("101", "10")]], // perp imbalance = 0
    };
    const spotBook: L2BookLike = {
      levels: [[level("25.0", "32.5")], [level("25.1", "67.5")]], // spot imbalance = -0.35
    };

    const perp = computePerpBookMetrics(perpBook)!;
    const spot = computeSpotBookMetrics(spotBook)!;

    expect(perp.imbalance).toBe(0);
    expect(spot.imbalance).toBeCloseTo(-0.35, 10);
    expect(spot.spreadBps).toBeGreaterThan(0);
  });

  it("returns null when the spot book is unavailable", () => {
    expect(computeSpotBookMetrics(null)).toBeNull();
  });
});
