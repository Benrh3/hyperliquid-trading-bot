import { WebSocket } from "ws";
import {
  WebSocketTransport,
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  type CandleWsEvent,
  type AllMidsWsEvent,
  type BboWsEvent,
  type ISubscription,
} from "@nktkas/hyperliquid";
import { bus } from "./events.js";
import { config, coins } from "./config.js";

type CandleInterval = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "1d" | "3d" | "1w" | "1M";

const VALID_INTERVALS: CandleInterval[] = [
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M",
];

const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m":  60_000,
  "3m":  3 * 60_000,
  "5m":  5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h":  60 * 60_000,
  "2h":  2 * 60 * 60_000,
  "4h":  4 * 60 * 60_000,
  "8h":  8 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d":  24 * 60 * 60_000,
  "3d":  3 * 24 * 60 * 60_000,
  "1w":  7 * 24 * 60 * 60_000,
  "1M":  30 * 24 * 60 * 60_000,
};

const HISTORY_CANDLES = 500;

function resolveInterval(raw: string): CandleInterval {
  if ((VALID_INTERVALS as string[]).includes(raw)) return raw as CandleInterval;
  console.warn(`[feed] Unknown interval "${raw}", defaulting to 1m`);
  return "1m";
}

export class Feed {
  private readonly client: SubscriptionClient;
  private readonly info:   InfoClient;
  private readonly coins:  string[];
  private interval:       CandleInterval;

  // Per-coin subscriptions
  private candleSubs = new Map<string, ISubscription>();
  private bboSubs:    ISubscription[] = [];
  private midsSub:    ISubscription | null = null;

  constructor() {
    const isTestnet = config.exchange.network === "testnet";
    const transport = new WebSocketTransport({
      isTestnet,
      reconnect: {
        WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
      },
    });
    this.client   = new SubscriptionClient({ transport });
    this.info     = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
    this.coins    = coins;
    this.interval = resolveInterval(config.strategy.interval);
  }

  getInterval(): string { return this.interval; }

  async start(): Promise<void> {
    console.log(`[feed] Connecting to ${config.exchange.network} — coins: ${this.coins.join(", ")} (${this.interval})`);

    // Prefill history for all coins before subscribing
    await Promise.all(this.coins.map((c) => this.fetchAndEmitHistory(c, this.interval)));

    // Subscribe to candles for every coin in parallel
    const candleSubEntries = await Promise.all(
      this.coins.map(async (coin) => {
        const sub = await this.client.candle(
          { coin, interval: this.interval },
          (evt) => this.onCandle(coin, evt),
        );
        return [coin, sub] as [string, ISubscription];
      }),
    );
    this.candleSubs = new Map(candleSubEntries);

    // Subscribe to BBO (bid/ask) for every coin
    this.bboSubs = await Promise.all(
      this.coins.map((coin) =>
        this.client.bbo({ coin }, (evt) => this.onBbo(coin, evt)),
      ),
    );

    // Single allMids subscription covers all coins
    this.midsSub = await this.client.allMids(this.onAllMids);

    console.log("[feed] Subscriptions active");
  }

  async stop(): Promise<void> {
    const all = [
      ...this.candleSubs.values(),
      ...this.bboSubs,
      this.midsSub,
    ].filter(Boolean) as ISubscription[];
    await Promise.all(all.map((s) => s.unsubscribe()));
    this.candleSubs.clear();
    this.bboSubs  = [];
    this.midsSub  = null;
    console.log("[feed] Subscriptions closed");
  }

  async changeInterval(newInterval: string): Promise<void> {
    const resolved = resolveInterval(newInterval);
    if (resolved === this.interval) return;

    // Unsubscribe all candle subs
    await Promise.all([...this.candleSubs.values()].map((s) => s.unsubscribe()));
    this.candleSubs.clear();

    this.interval = resolved;

    // Re-fetch history and re-subscribe for all coins
    await Promise.all(this.coins.map((c) => this.fetchAndEmitHistory(c, resolved)));

    const candleSubEntries = await Promise.all(
      this.coins.map(async (coin) => {
        const sub = await this.client.candle(
          { coin, interval: this.interval },
          (evt) => this.onCandle(coin, evt),
        );
        return [coin, sub] as [string, ISubscription];
      }),
    );
    this.candleSubs = new Map(candleSubEntries);

    console.log(`[feed] Interval changed to ${this.interval}`);
  }

  private async fetchAndEmitHistory(coin: string, interval: CandleInterval): Promise<void> {
    try {
      const endTime   = Date.now();
      const startTime = endTime - INTERVAL_MS[interval] * HISTORY_CANDLES;
      const candles   = await this.info.candleSnapshot({ coin, interval, startTime, endTime });

      console.log(`[feed] Fetched ${candles.length} historical ${interval} candles for ${coin}`);

      for (const c of candles) {
        bus.emit("candle", {
          coin,
          timestamp: c.t,
          open:   Number(c.o),
          high:   Number(c.h),
          low:    Number(c.l),
          close:  Number(c.c),
          volume: Number(c.v),
        });
      }
    } catch (e) {
      console.error(`[feed] History fetch failed for ${coin}:`, (e as Error).message);
    }
  }

  private onCandle = (coin: string, evt: CandleWsEvent): void => {
    bus.emit("candle", {
      coin,
      timestamp: evt.t,
      open:   Number(evt.o),
      high:   Number(evt.h),
      low:    Number(evt.l),
      close:  Number(evt.c),
      volume: Number(evt.v),
    });
  };

  private onAllMids = (evt: AllMidsWsEvent): void => {
    const midsMap = evt.mids as Record<string, string>;
    for (const coin of this.coins) {
      const mid = midsMap[coin];
      if (!mid) continue;
      bus.emit("tick", {
        coin,
        mid:       Number(mid),
        bid:       0,
        ask:       0,
        timestamp: Date.now(),
      });
    }
  };

  private onBbo = (coin: string, evt: BboWsEvent): void => {
    const [bid, ask] = evt.bbo;
    bus.emit("tick", {
      coin,
      mid:       (Number(bid.px) + Number(ask.px)) / 2,
      bid:       Number(bid.px),
      ask:       Number(ask.px),
      timestamp: evt.time,
    });
  };
}
