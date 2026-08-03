// Per-minute bucket ring for CEX liquidation events (market-spec.md §7 stage 4).
//
// Mirrors CvdTracker's bucket-ring pattern (src/market/tradesAggregator.ts):
// memory-bounded per-minute buckets, evicted past 24h, with a "filled
// fraction" so windows report partial coverage until they've been running
// long enough.
//
// CEX liquidation magnitudes are an undercount (Binance @forceOrder is
// throttled to ~1/sec per symbol; Bybit/OKX streams are more complete but
// still miss bursts during cascades). Use direction and spikes, not absolute
// notional. NEVER sum these with HL-native liquidation metrics — different
// methodologies (market-spec.md §6).

export const LIQ_BUCKET_MS = 60_000;
export const LIQ_WINDOW_1H_BUCKETS  = 60;
export const LIQ_WINDOW_24H_BUCKETS = 1440;

interface LiqBucket {
  bucketStart: number;
  longVol:     number; // forced-sell volume (long positions liquidated)
  shortVol:    number; // forced-buy volume (short positions liquidated)
  count:       number;
}

export interface CexLiqWindows {
  longVol1h:   number;
  shortVol1h:  number;
  count1h:     number;
  filled1h:    number;
  longVol24h:  number;
  shortVol24h: number;
  count24h:    number;
  filled24h:   number;
}

export interface CexLiqTrackerSnapshot {
  bootTime: number;
  buckets:  LiqBucket[];
}

/** Per-minute ring buffer of long/short liquidation volume + counts, covering the last 24h. */
export class CexLiqTracker {
  private buckets: LiqBucket[] = [];
  private bootTime: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.bootTime = now();
  }

  /** Rehydrate from a persisted snapshot. Restores buckets and bootTime, then evicts stale buckets. */
  rehydrate(snapshot: CexLiqTrackerSnapshot): void {
    this.bootTime = snapshot.bootTime;
    this.buckets  = snapshot.buckets.slice();
    const cutoff = this.now() - LIQ_WINDOW_24H_BUCKETS * LIQ_BUCKET_MS;
    while (this.buckets.length > 0 && this.buckets[0].bucketStart < cutoff) this.buckets.shift();
  }

  /** Serialize current state for persistence. */
  snapshot(): CexLiqTrackerSnapshot {
    return { bootTime: this.bootTime, buckets: this.buckets.slice() };
  }

  /** Record one liquidation event. `notionalUsd` is the dollar-value (qty × price). */
  recordLiq(side: "long" | "short", notionalUsd: number, timeMs: number): void {
    const bucketStart = Math.floor(timeMs / LIQ_BUCKET_MS) * LIQ_BUCKET_MS;
    let bucket = this.buckets.find((b) => b.bucketStart === bucketStart);

    if (!bucket) {
      bucket = { bucketStart, longVol: 0, shortVol: 0, count: 0 };
      const insertAt = this.buckets.findIndex((b) => b.bucketStart > bucketStart);
      if (insertAt === -1) this.buckets.push(bucket);
      else this.buckets.splice(insertAt, 0, bucket);

      const newest = this.buckets[this.buckets.length - 1].bucketStart;
      const cutoff = newest - LIQ_WINDOW_24H_BUCKETS * LIQ_BUCKET_MS;
      while (this.buckets.length > 0 && this.buckets[0].bucketStart < cutoff) this.buckets.shift();
    }

    if (side === "long") bucket.longVol += notionalUsd;
    else bucket.shortVol += notionalUsd;
    bucket.count += 1;
  }

  private sumWindow(windowBuckets: number): { longVol: number; shortVol: number; count: number } {
    const cutoff = this.now() - windowBuckets * LIQ_BUCKET_MS;
    let longVol = 0;
    let shortVol = 0;
    let count = 0;
    for (const b of this.buckets) {
      if (b.bucketStart < cutoff) continue;
      longVol += b.longVol;
      shortVol += b.shortVol;
      count += b.count;
    }
    return { longVol, shortVol, count };
  }

  private filledFraction(windowBuckets: number): number {
    const elapsedBuckets = Math.floor((this.now() - this.bootTime) / LIQ_BUCKET_MS) + 1;
    return Math.min(1, Math.max(0, elapsedBuckets) / windowBuckets);
  }

  getWindows(): CexLiqWindows {
    const w1h  = this.sumWindow(LIQ_WINDOW_1H_BUCKETS);
    const w24h = this.sumWindow(LIQ_WINDOW_24H_BUCKETS);
    return {
      longVol1h:   w1h.longVol,
      shortVol1h:  w1h.shortVol,
      count1h:     w1h.count,
      filled1h:    this.filledFraction(LIQ_WINDOW_1H_BUCKETS),
      longVol24h:  w24h.longVol,
      shortVol24h: w24h.shortVol,
      count24h:    w24h.count,
      filled24h:   this.filledFraction(LIQ_WINDOW_24H_BUCKETS),
    };
  }
}
