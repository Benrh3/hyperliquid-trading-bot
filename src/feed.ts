import { WebSocket } from "ws";
import {
  WebSocketTransport,
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

function resolveInterval(raw: string): CandleInterval {
  if ((VALID_INTERVALS as string[]).includes(raw)) return raw as CandleInterval;
  console.warn(`[feed] Unknown interval "${raw}", defaulting to 15m`);
  return "15m";
}

export class Feed {
  private client: SubscriptionClient;
  private coin: string;
  private interval: CandleInterval;
  private subs: ISubscription[] = [];

  constructor() {
    const isTestnet = config.exchange.network === "testnet";
    const transport = new WebSocketTransport({
      isTestnet,
      reconnect: {
        WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
      },
    });
    this.client = new SubscriptionClient({ transport });
    this.coin = config.exchange.coin;
    this.interval = resolveInterval(config.strategy.interval);
  }

  async start(): Promise<void> {
    console.log(`[feed] Connecting to ${config.exchange.network} — ${this.coin} candles (${this.interval})`);

    const [candleSub, midsSub, bboSub] = await Promise.all([
      this.client.candle({ coin: this.coin, interval: this.interval }, this.onCandle),
      this.client.allMids(this.onAllMids),
      this.client.bbo({ coin: this.coin }, this.onBbo),
    ]);

    this.subs.push(candleSub, midsSub, bboSub);
    console.log("[feed] Subscriptions active");
  }

  async stop(): Promise<void> {
    await Promise.all(this.subs.map((s) => s.unsubscribe()));
    this.subs = [];
    console.log("[feed] Subscriptions closed");
  }

  private onCandle = (evt: CandleWsEvent): void => {
    console.log(`[feed] candle  ${evt.s} o=${evt.o} h=${evt.h} l=${evt.l} c=${evt.c} v=${evt.v}`);
    bus.emit("candle", {
      timestamp: evt.t,
      open: Number(evt.o),
      high: Number(evt.h),
      low: Number(evt.l),
      close: Number(evt.c),
      volume: Number(evt.v),
    });
  };

  private onAllMids = (evt: AllMidsWsEvent): void => {
    const mid = (evt.mids as Record<string, string>)[this.coin];
    if (!mid) return;
    // Tick emitted here is mid-only; bid/ask are filled in by onBbo when it arrives
    bus.emit("tick", {
      coin: this.coin,
      mid: Number(mid),
      bid: 0,
      ask: 0,
      timestamp: Date.now(),
    });
  };

  private onBbo = (evt: BboWsEvent): void => {
    const [bid, ask] = evt.bbo;
    console.log(`[feed] tick    ${evt.coin} bid=${bid.px} ask=${ask.px}`);
    bus.emit("tick", {
      coin: this.coin,
      mid: (Number(bid.px) + Number(ask.px)) / 2,
      bid: Number(bid.px),
      ask: Number(ask.px),
      timestamp: evt.time,
    });
  };
}
