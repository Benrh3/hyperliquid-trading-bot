// Trades WS aggregator for the Market data subsystem (market-spec.md §7 stage 2).
//
// Maintains memory-bounded per-minute CVD (cumulative volume delta) buckets
// for a perp coin and its resolved spot coin. Observe-only: never throws
// outward, auto-reconnects with backoff on WS drop.
//
// Sign convention (verified empirically against a live trade vs. the L2 book):
// HL trade `side` is the TAKER's side — "B" = aggressor buy => +size,
// "A" = aggressor sell => -size. CVD = running sum of these signed sizes.

import { WebSocketTransport, SubscriptionClient, type ISubscription } from "@nktkas/hyperliquid";
import { WebSocket } from "ws";

export const BUCKET_MS = 60_000;
export const WINDOW_1H_BUCKETS  = 60;
export const WINDOW_4H_BUCKETS  = 240;
export const WINDOW_24H_BUCKETS = 1440;

const MAX_RECONNECT_DELAY_MS = 60_000;

interface Bucket {
  bucketStart:  number;
  buyVol:       number;
  sellVol:      number;
  tradeCount:   number;
}

export interface CoinWindows {
  cvd1h:      number;
  cvd4h:      number;
  cvd24h:     number;
  trades24h:  number;
  /** Fraction of each window covered by data accumulated since boot (1 once warm). */
  filled1h:   number;
  filled4h:   number;
  filled24h:  number;
}

/**
 * Per-minute ring buffer of signed taker volume + trade counts, covering the
 * last WINDOW_24H_BUCKETS (24h) minutes. Individual trades are never retained.
 */
export class CvdTracker {
  private buckets: Bucket[] = [];
  private readonly bootTime: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.bootTime = now();
  }

  /** Record one trade. `side`: "B" = aggressor buy (+size), "A" = aggressor sell (-size). */
  recordTrade(side: "B" | "A", size: number, timeMs: number): void {
    const bucketStart = Math.floor(timeMs / BUCKET_MS) * BUCKET_MS;
    let bucket = this.buckets.find((b) => b.bucketStart === bucketStart);

    if (!bucket) {
      bucket = { bucketStart, buyVol: 0, sellVol: 0, tradeCount: 0 };
      const insertAt = this.buckets.findIndex((b) => b.bucketStart > bucketStart);
      if (insertAt === -1) this.buckets.push(bucket);
      else this.buckets.splice(insertAt, 0, bucket);

      // Evict buckets older than 24h relative to the newest bucket — bounds
      // memory regardless of how sparsely trades arrive.
      const newest = this.buckets[this.buckets.length - 1].bucketStart;
      const cutoff = newest - WINDOW_24H_BUCKETS * BUCKET_MS;
      while (this.buckets.length > 0 && this.buckets[0].bucketStart < cutoff) this.buckets.shift();
    }

    if (side === "B") bucket.buyVol += size;
    else bucket.sellVol += size;
    bucket.tradeCount += 1;
  }

  /** Sum of buckets whose start time falls within the last `windowBuckets` minutes of now. */
  private sumWindow(windowBuckets: number): { net: number; trades: number } {
    const cutoff = this.now() - windowBuckets * BUCKET_MS;
    let net = 0;
    let trades = 0;
    for (const b of this.buckets) {
      if (b.bucketStart < cutoff) continue;
      net += b.buyVol - b.sellVol;
      trades += b.tradeCount;
    }
    return { net, trades };
  }

  private filledFraction(windowBuckets: number): number {
    const elapsedBuckets = Math.floor((this.now() - this.bootTime) / BUCKET_MS) + 1;
    return Math.min(1, Math.max(0, elapsedBuckets) / windowBuckets);
  }

  getWindows(): CoinWindows {
    const w1h  = this.sumWindow(WINDOW_1H_BUCKETS);
    const w4h  = this.sumWindow(WINDOW_4H_BUCKETS);
    const w24h = this.sumWindow(WINDOW_24H_BUCKETS);
    return {
      cvd1h:     w1h.net,
      cvd4h:     w4h.net,
      cvd24h:    w24h.net,
      trades24h: w24h.trades,
      filled1h:  this.filledFraction(WINDOW_1H_BUCKETS),
      filled4h:  this.filledFraction(WINDOW_4H_BUCKETS),
      filled24h: this.filledFraction(WINDOW_24H_BUCKETS),
    };
  }
}

/** Minimal subset of SubscriptionClient used by the aggregator — lets tests pass a mock. */
export interface TradesSubscriptionClient {
  trades(
    params: { coin: string },
    listener: (data: { side: "B" | "A"; px: string; sz: string; time: number }[]) => void,
  ): Promise<ISubscription>;
}

/**
 * Long-lived trades WS for one perp coin and (optionally) its resolved spot
 * coin. Maintains a CvdTracker per side. Auto-reconnects with exponential
 * backoff on subscribe failure; never throws into the caller.
 */
export class TradesAggregator {
  private readonly perpCoin: string;
  private readonly spotCoin: string | null;
  private readonly perpTracker = new CvdTracker();
  private readonly spotTracker = new CvdTracker();

  private client: TradesSubscriptionClient | null;
  private readonly ownsClient: boolean;
  private perpSub: ISubscription | null = null;
  private spotSub: ISubscription | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;
  private stopped = false;

  constructor(perpCoin: string, spotCoin: string | null, client?: TradesSubscriptionClient) {
    this.perpCoin = perpCoin;
    this.spotCoin = spotCoin;
    this.client = client ?? null;
    this.ownsClient = !client;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const subs = [this.perpSub, this.spotSub].filter((s): s is ISubscription => s !== null);
    this.perpSub = null;
    this.spotSub = null;
    await Promise.allSettled(subs.map((s) => s.unsubscribe()));
  }

  getPerpWindows(): CoinWindows {
    return this.perpTracker.getWindows();
  }

  /** null if no spot coin was resolved for this symbol. */
  getSpotWindows(): CoinWindows | null {
    return this.spotCoin ? this.spotTracker.getWindows() : null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    try {
      if (this.ownsClient) {
        const transport = new WebSocketTransport({
          reconnect: { WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
        });
        this.client = new SubscriptionClient({ transport });
      }
      const client = this.client!;

      this.perpSub = await client.trades({ coin: this.perpCoin }, (data) => this.onTrades(this.perpTracker, data));
      if (this.spotCoin) {
        this.spotSub = await client.trades({ coin: this.spotCoin }, (data) => this.onTrades(this.spotTracker, data));
      }

      this.reconnectDelayMs = 1000;
      console.log(
        `[trades-aggregator] Subscribed to trades for ${this.perpCoin}` +
        (this.spotCoin ? `, ${this.spotCoin}` : ""),
      );
    } catch (e) {
      console.warn(
        `[trades-aggregator] Subscribe failed (${(e as Error).message}) — retrying in ${this.reconnectDelayMs}ms`,
      );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  }

  private onTrades(tracker: CvdTracker, data: { side: "B" | "A"; px: string; sz: string; time: number }[]): void {
    try {
      for (const t of data) {
        const size = Number(t.sz);
        if (!Number.isFinite(size)) continue;
        tracker.recordTrade(t.side, size, t.time);
      }
    } catch (e) {
      console.warn(`[trades-aggregator] Failed to process trade batch: ${(e as Error).message}`);
    }
  }
}
