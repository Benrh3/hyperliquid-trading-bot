// L2 book microstructure metrics for the Market data subsystem
// (market-spec.md §7 stage 2). Polled point-in-time at snapshot interval —
// not streamed. Inside-book only: top ~20 levels per side.

const DEFAULT_DEPTH = 20;

export interface L2BookLevel {
  px: string;
  sz: string;
}

export interface L2BookLike {
  levels: [L2BookLevel[], L2BookLevel[]];
}

export interface PerpBookMetrics {
  mid:       number;
  spreadBps: number;
  bidDepth:  number;
  askDepth:  number;
  imbalance: number;
}

export interface SpotBookMetrics {
  spreadBps: number;
  imbalance: number;
}

/**
 * book_mid, book_spread_bps, book_bid_depth, book_ask_depth, book_imbalance.
 * Returns null if either side of the book is empty (can't compute mid/spread).
 */
export function computePerpBookMetrics(book: L2BookLike | null, depth = DEFAULT_DEPTH): PerpBookMetrics | null {
  if (!book) return null;
  const [bids, asks] = book.levels;
  if (bids.length === 0 || asks.length === 0) return null;

  const bestBid = Number(bids[0].px);
  const bestAsk = Number(asks[0].px);
  const mid = (bestBid + bestAsk) / 2;
  if (mid <= 0) return null;

  const bidDepth = sumDepth(bids, depth);
  const askDepth = sumDepth(asks, depth);
  const totalDepth = bidDepth + askDepth;

  return {
    mid,
    spreadBps: ((bestAsk - bestBid) / mid) * 1e4,
    bidDepth,
    askDepth,
    imbalance: totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0,
  };
}

/** book_spot_spread_bps, book_spot_imbalance. */
export function computeSpotBookMetrics(book: L2BookLike | null, depth = DEFAULT_DEPTH): SpotBookMetrics | null {
  const perp = computePerpBookMetrics(book, depth);
  if (!perp) return null;
  return { spreadBps: perp.spreadBps, imbalance: perp.imbalance };
}

function sumDepth(levels: L2BookLevel[], depth: number): number {
  let total = 0;
  for (const lvl of levels.slice(0, depth)) total += Number(lvl.sz);
  return total;
}
