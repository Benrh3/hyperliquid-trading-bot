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
import { config } from "./config.js";

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
  private readonly info: InfoClient;
  private readonly coin: string;
  private interval: CandleInterval;
  private candleSub: ISubscription | null = null;
  private otherSubs: ISubscription[] = [];

  constructor() {
    const isTestnet = config.exchange.network === "testnet";
    const transport = new WebSocketTransport({
      isTestnet,
      reconnect: {
        WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
      },
    });
    this.client = new SubscriptionClient({ transport });
    this.info = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
    this.coin = config.exchange.coin;
    this.interval = resolveInterval(config.strategy.interval);
  }

  getInterval(): string {
    return this.interval;
  }

  async start(): Promise<void> {
    console.log(`[feed] Connecting to ${config.exchange.network} — ${this.coin} candles (${this.interval})`);

    // Prefill history before subscribing so the chart has immediate context
    await this.fetchAndEmitHistory(this.interval);

    const [candleSub, midsSub, bboSub] = await Promise.all([
      this.client.candle({ coin: this.coin, interval: this.interval }, this.onCandle),
      this.client.allMids(this.onAllMids),
      this.client.bbo({ coin: this.coin }, this.onBbo),
    ]);

    this.candleSub = candleSub;
    this.otherSubs = [midsSub, bboSub];
    console.log("[feed] Subscriptions active");
  }

  async stop(): Promise<void> {
    const all = [this.candleSub, ...this.otherSubs].filter(Boolean) as ISubscription[];
    await Promise.all(all.map((s) => s.unsubscribe()));
    this.candleSub = null;
    this.otherSubs = [];
    console.log("[feed] Subscriptions closed");
  }

  async changeInterval(newInterval: string): Promise<void> {
    const resolved = resolveInterval(newInterval);
    if (resolved === this.interval) return;

    if (this.candleSub) {
      await this.candleSub.unsubscribe();
      this.candleSub = null;
    }

    this.interval = resolved;
    await this.fetchAndEmitHistory(resolved);

    this.candleSub = await this.client.candle(
      { coin: this.coin, interval: this.interval },
      this.onCandle,
    );

    console.log(`[feed] Interval changed to ${this.interval}`);
  }

  private async fetchAndEmitHistory(interval: CandleInterval): Promise<void> {
    try {
      const endTime = Date.now();
      const startTime = endTime - INTERVAL_MS[interval] * HISTORY_CANDLES;

      const candles = await this.info.candleSnapshot({
        coin: this.coin,
        interval,
        startTime,
        endTime,
      });

      console.log(`[feed] Fetched ${candles.length} historical ${interval} candles`);

      for (const c of candles) {
        bus.emit("candle", {
          timestamp: c.t,
          open:   Number(c.o),
          high:   Number(c.h),
          low:    Number(c.l),
          close:  Number(c.c),
          volume: Number(c.v),
        });
      }
    } catch (e) {
      console.error("[feed] History fetch failed:", (e as Error).message);
    }
  }

  private onCandle = (evt: CandleWsEvent): void => {
    console.log(`[feed] candle  ${evt.s} o=${evt.o} h=${evt.h} l=${evt.l} c=${evt.c} v=${evt.v}`);
    bus.emit("candle", {
      timestamp: evt.t,
      open:   Number(evt.o),
      high:   Number(evt.h),
      low:    Number(evt.l),
      close:  Number(evt.c),
      volume: Number(evt.v),
    });
  };

  private onAllMids = (evt: AllMidsWsEvent): void => {
    const mid = (evt.mids as Record<string, string>)[this.coin];
    if (!mid) return;
    bus.emit("tick", {
      coin:      this.coin,
      mid:       Number(mid),
      bid:       0,
      ask:       0,
      timestamp: Date.now(),
    });
  };

  private onBbo = (evt: BboWsEvent): void => {
    const [bid, ask] = evt.bbo;
    console.log(`[feed] tick    ${evt.coin} bid=${bid.px} ask=${ask.px}`);
    bus.emit("tick", {
      coin:      this.coin,
      mid:       (Number(bid.px) + Number(ask.px)) / 2,
      bid:       Number(bid.px),
      ask:       Number(ask.px),
      timestamp: evt.time,
    });
  };
}
