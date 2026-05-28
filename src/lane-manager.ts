import { WebSocket } from "ws";
import {
  WebSocketTransport,
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  type CandleWsEvent,
  type ISubscription,
} from "@nktkas/hyperliquid";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { bus } from "./events.js";
import { config, coins } from "./config.js";
import { STRATEGY_REGISTRY, getStrategyEntry } from "./strategy/registry.js";
import type { Strategy } from "./strategy/base.js";
import type { Candle, Signal } from "./events.js";

const LANES_PATH = resolve(process.cwd(), "config", "lanes.json");
const INITIAL_EQUITY = 1000;
const SLIPPAGE       = 0.0005;
const MAX_HISTORY    = 600;

const TF_MS: Record<string, number> = {
  "1m":  60_000,
  "1h":  3_600_000,
  "4h":  14_400_000,
};

export interface LaneConfig {
  strategyId: string;
  timeframe:  string;
  active:     boolean;
  live:       boolean;
}

export interface LanesFile {
  lanes: LaneConfig[];
}

export interface LaneState {
  strategyId:    string;
  displayName:   string;
  timeframe:     string;
  live:          boolean;
  equity:        number;
  unrealisedPnl: number;
  position: {
    side:          "long" | "short";
    entryPrice:    number;
    size:          number;
    entryTime:     number;
    unrealisedPnl: number;
  } | null;
  sessionPnl: number;
  tradeCount: number;
}

interface AggBuffer {
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
  bucket:    number;   // Math.floor(timestamp / tfMs)
  timestamp: number;   // bucket * tfMs (start of this bar)
}

interface Lane {
  config:   LaneConfig;
  strategy: Strategy;
  state:    LaneState;
  history:  Candle[];  // at the lane's own timeframe
}

export class LaneManager {
  private lanes:      Lane[]  = [];
  private lanesFile:  LanesFile;
  private readonly coin: string;
  private isWarming = false;

  // Shared histories (all lanes on the same TF share one history)
  private hist1m:       Candle[]               = [];
  private aggHistories: Map<string, Candle[]>  = new Map(); // tf -> []
  private aggBuffers:   Map<string, AggBuffer> = new Map(); // tf -> buf

  private wsClient: SubscriptionClient | null = null;
  private info:     InfoClient;
  private subs:     ISubscription[] = [];

  constructor() {
    this.coin = coins[0];
    const isTestnet = config.exchange.network === "testnet";
    this.info = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
    this.lanesFile = this.loadFile();
    this.buildLanes();
  }

  // ── Config persistence ───────────────────────────────────────────────────

  private loadFile(): LanesFile {
    try {
      if (existsSync(LANES_PATH)) {
        return JSON.parse(readFileSync(LANES_PATH, "utf-8")) as LanesFile;
      }
    } catch { /* fall through to defaults */ }
    return {
      lanes: STRATEGY_REGISTRY
        .filter((e) => e.isCandleStrategy)
        .map((e, i) => ({
          strategyId: e.id,
          timeframe:  "1h",
          active:     i === 0,
          live:       i === 0,
        })),
    };
  }

  private saveFile(): void {
    writeFileSync(LANES_PATH, JSON.stringify(this.lanesFile, null, 2));
  }

  // ── Lane construction ────────────────────────────────────────────────────

  private buildLanes(): void {
    this.lanes = [];
    for (const lc of this.lanesFile.lanes) {
      if (!lc.active) continue;
      const entry = getStrategyEntry(lc.strategyId);
      if (!entry?.isCandleStrategy || !entry.factory) continue;
      this.lanes.push({
        config:   lc,
        strategy: entry.factory(),
        history:  [],
        state: {
          strategyId:    lc.strategyId,
          displayName:   entry.displayName,
          timeframe:     lc.timeframe,
          live:          lc.live,
          equity:        INITIAL_EQUITY,
          unrealisedPnl: 0,
          position:      null,
          sessionPnl:    0,
          tradeCount:    0,
        },
      });
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  getLaneStates(): LaneState[] {
    return this.lanes.map((l) => ({ ...l.state }));
  }

  getLanesFile(): LanesFile {
    return this.lanesFile;
  }

  async applyConfig(newFile: LanesFile): Promise<void> {
    const liveCount = newFile.lanes.filter((l) => l.active && l.live).length;
    if (liveCount > 1) throw new Error("Only one lane may be marked live");
    this.lanesFile = newFile;
    this.saveFile();
    this.buildLanes();
    if (this.wsClient) await this.warmupAll();
    console.log(`[lane-manager] Config applied — ${this.lanes.length} active lane(s)`);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const isTestnet = config.exchange.network === "testnet";
    const transport = new WebSocketTransport({
      isTestnet,
      reconnect: { WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
    });
    this.wsClient = new SubscriptionClient({ transport });

    await this.warmupAll();

    // ONE 1m subscription serves all lanes regardless of their configured timeframe
    const sub = await this.wsClient.candle(
      { coin: this.coin, interval: "1m" },
      (evt) => this.on1mCandle(evt),
    );
    this.subs.push(sub);
    console.log(`[lane-manager] Live — ${this.lanes.length} active lane(s)`);
  }

  async stop(): Promise<void> {
    await Promise.all(this.subs.map((s) => s.unsubscribe()));
    this.subs = [];
  }

  // ── Historical warm-up ───────────────────────────────────────────────────

  private async warmupAll(): Promise<void> {
    this.isWarming = true;
    try {
      // Clear aggregation state so rebuilds are clean
      this.aggBuffers.clear();
      this.aggHistories.clear();

      const uniqueTfs = new Set(this.lanes.map((l) => l.config.timeframe));
      await Promise.all([...uniqueTfs].map((tf) => this.fetchHistory(tf)));
      for (const lane of this.lanes) this.warmupLane(lane);
    } finally {
      this.isWarming = false;
    }
  }

  private async fetchHistory(tf: string): Promise<void> {
    try {
      const tfMs = TF_MS[tf] ?? 3_600_000;
      const endTime   = Date.now();
      const startTime = endTime - 500 * tfMs;
      const raw = await this.info.candleSnapshot({
        coin:      this.coin,
        interval:  tf as "1m",
        startTime,
        endTime,
      });
      const candles: Candle[] = raw.map((c) => ({
        coin:      this.coin,
        timestamp: c.t,
        open:      Number(c.o),
        high:      Number(c.h),
        low:       Number(c.l),
        close:     Number(c.c),
        volume:    Number(c.v),
      }));
      if (tf === "1m") {
        this.hist1m = candles;
      } else {
        this.aggHistories.set(tf, candles);
      }
      console.log(`[lane-manager] Fetched ${candles.length} ${tf} candles`);
    } catch (e) {
      console.error(`[lane-manager] History fetch failed (${tf}):`, (e as Error).message);
    }
  }

  private warmupLane(lane: Lane): void {
    const hist =
      lane.config.timeframe === "1m"
        ? this.hist1m
        : (this.aggHistories.get(lane.config.timeframe) ?? []);
    lane.history = hist.slice();
    // Drive the strategy through historical candles to warm up its internal state —
    // no paper trading during warm-up, only live candles paper-trade.
    for (let i = 0; i < hist.length; i++) {
      lane.strategy.onCandle(hist[i], hist.slice(0, i + 1));
    }
    console.log(
      `[lane-manager] Warmed ${lane.config.strategyId}/${lane.config.timeframe}` +
      ` — ${hist.length} candles`,
    );
  }

  // ── Live candle processing ───────────────────────────────────────────────

  private on1mCandle(evt: CandleWsEvent): void {
    if (this.isWarming) return;

    const candle: Candle = {
      coin:      this.coin,
      timestamp: evt.t,
      open:      Number(evt.o),
      high:      Number(evt.h),
      low:       Number(evt.l),
      close:     Number(evt.c),
      volume:    Number(evt.v),
    };

    // Upsert into 1m history
    const idx = this.hist1m.findIndex((c) => c.timestamp === candle.timestamp);
    if (idx >= 0) {
      // Existing bar updating (live WS resends current bar on each tick)
      this.hist1m[idx] = candle;
      this.updateAggClose(candle);
      for (const lane of this.lanes) {
        if (lane.config.timeframe === "1m") this.markPosition(lane, candle.close);
      }
      return;
    }

    // New closed 1m bar
    this.hist1m.push(candle);
    if (this.hist1m.length > MAX_HISTORY) this.hist1m.shift();

    // Dispatch to 1m lanes
    for (const lane of this.lanes) {
      if (lane.config.timeframe !== "1m") continue;
      this.checkStopLoss(lane, candle);
      lane.history.push(candle);
      if (lane.history.length > MAX_HISTORY) lane.history.shift();
      const signal = lane.strategy.onCandle(candle, lane.history.slice());
      if (signal) this.applySignal(lane, signal, candle);
      this.markPosition(lane, candle.close);
    }

    // Aggregate into higher timeframes
    for (const [tf, tfMs] of [["1h", TF_MS["1h"]], ["4h", TF_MS["4h"]]] as [string, number][]) {
      this.aggregate(candle, tf, tfMs);
    }
  }

  private updateAggClose(candle: Candle): void {
    for (const buf of this.aggBuffers.values()) {
      buf.high  = Math.max(buf.high, candle.high);
      buf.low   = Math.min(buf.low,  candle.low);
      buf.close = candle.close;
    }
    // Update mark price for higher-TF lanes using latest close
    for (const lane of this.lanes) {
      if (lane.config.timeframe !== "1m") this.markPosition(lane, candle.close);
    }
  }

  private aggregate(candle: Candle, tf: string, tfMs: number): void {
    const bucket = Math.floor(candle.timestamp / tfMs);
    const buf    = this.aggBuffers.get(tf);

    if (!buf) {
      this.aggBuffers.set(tf, {
        open: candle.open, high: candle.high, low: candle.low,
        close: candle.close, volume: candle.volume,
        bucket, timestamp: bucket * tfMs,
      });
      return;
    }

    if (buf.bucket === bucket) {
      buf.high    = Math.max(buf.high, candle.high);
      buf.low     = Math.min(buf.low,  candle.low);
      buf.close   = candle.close;
      buf.volume += candle.volume;
      return;
    }

    // Previous bucket complete — emit it
    const completed: Candle = {
      coin:      this.coin,
      timestamp: buf.timestamp,
      open:      buf.open,
      high:      buf.high,
      low:       buf.low,
      close:     buf.close,
      volume:    buf.volume,
    };

    const hist = this.aggHistories.get(tf) ?? [];
    hist.push(completed);
    if (hist.length > MAX_HISTORY) hist.shift();
    this.aggHistories.set(tf, hist);

    for (const lane of this.lanes) {
      if (lane.config.timeframe !== tf) continue;
      this.checkStopLoss(lane, completed);
      lane.history.push(completed);
      if (lane.history.length > MAX_HISTORY) lane.history.shift();
      const signal = lane.strategy.onCandle(completed, lane.history.slice());
      if (signal) this.applySignal(lane, signal, completed);
      this.markPosition(lane, completed.close);
    }

    // Start new buffer
    this.aggBuffers.set(tf, {
      open: candle.open, high: candle.high, low: candle.low,
      close: candle.close, volume: candle.volume,
      bucket, timestamp: bucket * tfMs,
    });
  }

  // ── Paper simulation ─────────────────────────────────────────────────────

  private checkStopLoss(lane: Lane, candle: Candle): void {
    const pos = lane.state.position;
    if (!pos) return;
    const stopPct = config.risk.stopLossPercent;
    const loss    = pos.side === "long"
      ? (pos.entryPrice - candle.low)  / pos.entryPrice * 100
      : (candle.high - pos.entryPrice) / pos.entryPrice * 100;
    if (loss < stopPct) return;
    const exitPx = pos.side === "long"
      ? pos.entryPrice * (1 - stopPct / 100) * (1 - SLIPPAGE)
      : pos.entryPrice * (1 + stopPct / 100) * (1 + SLIPPAGE);
    this.closePosition(lane, exitPx, `Stop-loss ${loss.toFixed(1)}%`);
  }

  private applySignal(lane: Lane, signal: Signal, candle: Candle): void {
    if (signal.side === "close") {
      if (!lane.state.position) return;
      const exitPx = lane.state.position.side === "long"
        ? candle.close * (1 - SLIPPAGE)
        : candle.close * (1 + SLIPPAGE);
      this.closePosition(lane, exitPx, signal.reason);
    } else {
      if (lane.state.position && lane.state.position.side !== signal.side) {
        const exitPx = lane.state.position.side === "long"
          ? candle.close * (1 - SLIPPAGE)
          : candle.close * (1 + SLIPPAGE);
        this.closePosition(lane, exitPx, `Reversed to ${signal.side}`);
      }
      if (!lane.state.position) {
        const entryPx = signal.side === "long"
          ? candle.close * (1 + SLIPPAGE)
          : candle.close * (1 - SLIPPAGE);
        const size = config.risk.maxPositionSizeUsd / entryPx;
        lane.state.position = {
          side: signal.side, entryPrice: entryPx,
          size, entryTime: candle.timestamp, unrealisedPnl: 0,
        };
        console.log(
          `[lane-manager] ${lane.config.strategyId}/${lane.config.timeframe}` +
          ` OPEN ${signal.side.toUpperCase()} @ ${entryPx.toFixed(2)}`,
        );
      }
    }
    // Forward to bus only for the live lane (→ risk manager → executor)
    if (lane.config.live) bus.emit("signal", signal);
  }

  private closePosition(lane: Lane, exitPx: number, reason: string): void {
    const pos = lane.state.position;
    if (!pos) return;
    const pnl = pos.side === "long"
      ? (exitPx - pos.entryPrice) * pos.size
      : (pos.entryPrice - exitPx) * pos.size;
    lane.state.equity        += pnl;
    lane.state.sessionPnl    += pnl;
    lane.state.tradeCount++;
    lane.state.position      = null;
    lane.state.unrealisedPnl = 0;
    console.log(
      `[lane-manager] ${lane.config.strategyId}/${lane.config.timeframe}` +
      ` CLOSE @ ${exitPx.toFixed(2)} PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} (${reason})`,
    );
  }

  private markPosition(lane: Lane, currentPrice: number): void {
    const pos = lane.state.position;
    if (!pos) { lane.state.unrealisedPnl = 0; return; }
    const upnl = pos.side === "long"
      ? (currentPrice - pos.entryPrice) * pos.size
      : (pos.entryPrice - currentPrice) * pos.size;
    pos.unrealisedPnl        = upnl;
    lane.state.unrealisedPnl = upnl;
  }
}
