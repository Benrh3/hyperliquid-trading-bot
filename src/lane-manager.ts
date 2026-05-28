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

const LANES_PATH     = resolve(process.cwd(), "config", "lanes.json");
const INITIAL_EQUITY = 1000;
const SLIPPAGE       = 0.0005;
const TAKER_FEE      = 0.00045; // 0.045% per leg
const MAX_HISTORY    = 600;
const FUNDING_POLL_MS = 60_000;
const HOUR_MS         = 3_600_000;

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
    side:          "long" | "short" | "neutral";
    entryPrice:    number;
    size:          number;
    entryTime:     number;
    unrealisedPnl: number;
  } | null;
  sessionPnl: number;
  tradeCount: number;
}

// ── Candle lane internals ─────────────────────────────────────────────────────

interface AggBuffer {
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
  bucket:    number;
  timestamp: number;
}

interface CandleLane {
  config:   LaneConfig;
  strategy: Strategy;
  state:    LaneState;
  history:  Candle[];
}

// ── Funding-basis lane internals ──────────────────────────────────────────────

interface FundingLane {
  config:     LaneConfig;
  notional:   number;
  entryPrice: number;
  openTime:   number;
  equity:     number;    // notional - entryFees, then += accrued funding each period
  sessionPnl: number;    // net of fees
  periods:    number;    // completed funding periods accrued
  lastRate:   number;    // most recent hourly rate (for live unrealised estimate)
  lastBucket: number;    // hour bucket already accrued (prevents double-count)
  pollTimer:  ReturnType<typeof setInterval>;
}

export class LaneManager {
  private candleLanes: CandleLane[] = [];
  private fundingLane: FundingLane | null = null;
  private lanesFile:   LanesFile;
  private readonly coin: string;
  private isWarming = false;

  private hist1m:       Candle[]               = [];
  private aggHistories: Map<string, Candle[]>  = new Map();
  private aggBuffers:   Map<string, AggBuffer> = new Map();

  private wsClient: SubscriptionClient | null = null;
  private info:     InfoClient;
  private subs:     ISubscription[] = [];

  constructor() {
    this.coin = coins[0];
    const isTestnet = config.exchange.network === "testnet";
    this.info = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
    this.lanesFile = this.loadFile();
    this.rebuild();
  }

  // ── Config persistence ───────────────────────────────────────────────────

  private loadFile(): LanesFile {
    try {
      if (existsSync(LANES_PATH)) {
        return JSON.parse(readFileSync(LANES_PATH, "utf-8")) as LanesFile;
      }
    } catch { /* fall through */ }
    return {
      lanes: STRATEGY_REGISTRY
        .filter((e) => e.isCandleStrategy || e.id === "funding-basis")
        .map((e, i) => ({
          strategyId: e.id,
          timeframe:  "1h",
          active:     i === 0,
          live:       i === 0 && e.isCandleStrategy,
        })),
    };
  }

  private saveFile(): void {
    writeFileSync(LANES_PATH, JSON.stringify(this.lanesFile, null, 2));
  }

  // ── Build / rebuild lanes ────────────────────────────────────────────────

  private rebuild(): void {
    this.candleLanes = [];
    for (const lc of this.lanesFile.lanes) {
      if (!lc.active || lc.strategyId === "funding-basis") continue;
      const entry = getStrategyEntry(lc.strategyId);
      if (!entry?.isCandleStrategy || !entry.factory) continue;
      this.candleLanes.push({
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
    // Funding lane is NOT rebuilt here — handled separately in applyConfig to
    // preserve equity across config saves or open/close on toggle.
  }

  // ── Public API ───────────────────────────────────────────────────────────

  getLaneStates(): LaneState[] {
    const states: LaneState[] = this.candleLanes.map((l) => ({ ...l.state }));

    if (this.fundingLane) {
      const fl = this.fundingLane;
      const msIntoHour   = Date.now() % HOUR_MS;
      const partialAccrual = fl.lastRate * fl.notional * (msIntoHour / HOUR_MS);
      states.push({
        strategyId:    "funding-basis",
        displayName:   "Funding Basis",
        timeframe:     "—",
        live:          false,
        equity:        fl.equity + partialAccrual,
        unrealisedPnl: partialAccrual,
        position: {
          side:          "neutral",
          entryPrice:    fl.entryPrice,
          size:          fl.notional / fl.entryPrice,
          entryTime:     fl.openTime,
          unrealisedPnl: partialAccrual,
        },
        sessionPnl: fl.sessionPnl + partialAccrual,
        tradeCount: fl.periods,
      });
    }

    return states;
  }

  getLanesFile(): LanesFile { return this.lanesFile; }

  async applyConfig(newFile: LanesFile): Promise<void> {
    const liveCount = newFile.lanes.filter((l) => l.active && l.live).length;
    if (liveCount > 1) throw new Error("Only one lane may be marked live");

    // Determine funding-basis transition before overwriting the file
    const oldFundingCfg = this.lanesFile.lanes.find((l) => l.strategyId === "funding-basis");
    const newFundingCfg = newFile.lanes.find((l) => l.strategyId === "funding-basis");
    const wasActive = oldFundingCfg?.active ?? false;
    const nowActive = newFundingCfg?.active ?? false;

    this.lanesFile = newFile;
    this.saveFile();
    this.rebuild(); // rebuilds candle lanes only

    if (this.wsClient) {
      await this.warmupAll(); // re-warm candle lanes

      if (!wasActive && nowActive) {
        await this.openFundingLane(newFundingCfg!);
      } else if (wasActive && !nowActive) {
        this.closeFundingLane();
      }
      // If stays active: keep existing fundingLane state (preserve earned P&L)
      // Update config reference in case other fields changed
      if (wasActive && nowActive && this.fundingLane) {
        this.fundingLane.config = newFundingCfg!;
      }
    }

    console.log(`[lane-manager] Config applied — ${this.candleLanes.length} candle lane(s), funding lane: ${nowActive ? "on" : "off"}`);
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

    // ONE 1m subscription for all candle lanes
    const sub = await this.wsClient.candle(
      { coin: this.coin, interval: "1m" },
      (evt) => this.on1mCandle(evt),
    );
    this.subs.push(sub);

    // Open funding lane if configured active at startup
    const fundingCfg = this.lanesFile.lanes.find((l) => l.strategyId === "funding-basis");
    if (fundingCfg?.active) {
      await this.openFundingLane(fundingCfg);
    }

    console.log(
      `[lane-manager] Live — ${this.candleLanes.length} candle lane(s),` +
      ` funding lane: ${this.fundingLane ? "on" : "off"}`,
    );
  }

  async stop(): Promise<void> {
    await Promise.all(this.subs.map((s) => s.unsubscribe()));
    this.subs = [];
    if (this.fundingLane) this.closeFundingLane();
  }

  // ── Funding lane ─────────────────────────────────────────────────────────

  private async openFundingLane(lc: LaneConfig): Promise<void> {
    if (this.fundingLane) return; // already open

    // Entry fees: 2 taker legs (spot buy + perp short)
    const entryFees = 2 * TAKER_FEE * INITIAL_EQUITY;
    const entryPrice = this.hist1m.length > 0
      ? this.hist1m[this.hist1m.length - 1].close
      : 0;

    if (entryPrice <= 0) {
      console.warn("[lane-manager] Funding lane: no candle price available yet, will retry");
      // Try again shortly
      setTimeout(() => { void this.openFundingLane(lc); }, 5_000);
      return;
    }

    const now = Date.now();
    const fl: FundingLane = {
      config:     lc,
      notional:   INITIAL_EQUITY,
      entryPrice,
      openTime:   now,
      equity:     INITIAL_EQUITY - entryFees,
      sessionPnl: -entryFees,
      periods:    0,
      lastRate:   0,
      lastBucket: Math.floor(now / HOUR_MS),
      pollTimer:  setInterval(() => { void this.pollFunding(); }, FUNDING_POLL_MS),
    };
    this.fundingLane = fl;

    console.log(
      `[lane-manager] Funding lane OPEN @ $${entryPrice.toFixed(2)}` +
      ` notional=$${INITIAL_EQUITY} entry fees=$${entryFees.toFixed(4)}`,
    );

    // Fetch initial rate immediately
    void this.pollFunding();
  }

  private closeFundingLane(): void {
    const fl = this.fundingLane;
    if (!fl) return;

    clearInterval(fl.pollTimer);

    // Exit fees: 2 taker legs (spot sell + perp close)
    const exitFees = 2 * TAKER_FEE * fl.notional;
    fl.equity     -= exitFees;
    fl.sessionPnl -= exitFees;

    console.log(
      `[lane-manager] Funding lane CLOSE` +
      ` periods=${fl.periods} netPnl=${fl.sessionPnl >= 0 ? "+" : ""}${fl.sessionPnl.toFixed(4)}` +
      ` exit fees=$${exitFees.toFixed(4)}`,
    );

    this.fundingLane = null;
  }

  private async pollFunding(): Promise<void> {
    const fl = this.fundingLane;
    if (!fl) return;
    try {
      const [meta, assetCtxs] = await this.info.metaAndAssetCtxs();
      const idx = meta.universe.findIndex((u) => u.name === this.coin);
      if (idx === -1) return;

      const rate = parseFloat(assetCtxs[idx].funding);
      fl.lastRate = rate;

      // Accrue when an hour boundary has passed since last accrual
      const currentBucket = Math.floor(Date.now() / HOUR_MS);
      if (currentBucket > fl.lastBucket) {
        // Each completed bucket earns one period of funding
        const periodsElapsed = currentBucket - fl.lastBucket;
        const earned = rate * fl.notional * periodsElapsed;
        fl.equity     += earned;
        fl.sessionPnl += earned;
        fl.periods    += periodsElapsed;
        fl.lastBucket  = currentBucket;
        console.log(
          `[lane-manager] Funding accrual × ${periodsElapsed}` +
          ` rate=${(rate * 100).toFixed(4)}% earned=${earned >= 0 ? "+" : ""}${earned.toFixed(4)}`,
        );
      }
    } catch (e) {
      console.error("[lane-manager] Funding poll failed:", (e as Error).message);
    }
  }

  // ── Candle history warm-up ───────────────────────────────────────────────

  private async warmupAll(): Promise<void> {
    this.isWarming = true;
    try {
      this.aggBuffers.clear();
      this.aggHistories.clear();
      const uniqueTfs = new Set(this.candleLanes.map((l) => l.config.timeframe));
      await Promise.all([...uniqueTfs].map((tf) => this.fetchHistory(tf)));
      for (const lane of this.candleLanes) this.warmupLane(lane);
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
      if (tf === "1m") this.hist1m = candles;
      else this.aggHistories.set(tf, candles);
      console.log(`[lane-manager] Fetched ${candles.length} ${tf} candles`);
    } catch (e) {
      console.error(`[lane-manager] History fetch failed (${tf}):`, (e as Error).message);
    }
  }

  private warmupLane(lane: CandleLane): void {
    const hist =
      lane.config.timeframe === "1m"
        ? this.hist1m
        : (this.aggHistories.get(lane.config.timeframe) ?? []);
    lane.history = hist.slice();
    for (let i = 0; i < hist.length; i++) {
      lane.strategy.onCandle(hist[i], hist.slice(0, i + 1));
    }
    console.log(`[lane-manager] Warmed ${lane.config.strategyId}/${lane.config.timeframe} — ${hist.length} candles`);
  }

  // ── Live 1m candle processing ────────────────────────────────────────────

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

    const idx   = this.hist1m.findIndex((c) => c.timestamp === candle.timestamp);
    const isNew = idx < 0;

    if (!isNew) {
      this.hist1m[idx] = candle;
      this.updateAggClose(candle);
      for (const lane of this.candleLanes) {
        if (lane.config.timeframe === "1m") this.markPosition(lane, candle.close);
      }
      return;
    }

    this.hist1m.push(candle);
    if (this.hist1m.length > MAX_HISTORY) this.hist1m.shift();

    for (const lane of this.candleLanes) {
      if (lane.config.timeframe !== "1m") continue;
      this.checkStopLoss(lane, candle);
      lane.history.push(candle);
      if (lane.history.length > MAX_HISTORY) lane.history.shift();
      const signal = lane.strategy.onCandle(candle, lane.history.slice());
      if (signal) this.applySignal(lane, signal, candle);
      this.markPosition(lane, candle.close);
    }

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
    for (const lane of this.candleLanes) {
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

    for (const lane of this.candleLanes) {
      if (lane.config.timeframe !== tf) continue;
      this.checkStopLoss(lane, completed);
      lane.history.push(completed);
      if (lane.history.length > MAX_HISTORY) lane.history.shift();
      const signal = lane.strategy.onCandle(completed, lane.history.slice());
      if (signal) this.applySignal(lane, signal, completed);
      this.markPosition(lane, completed.close);
    }

    this.aggBuffers.set(tf, {
      open: candle.open, high: candle.high, low: candle.low,
      close: candle.close, volume: candle.volume,
      bucket, timestamp: bucket * tfMs,
    });
  }

  // ── Candle-lane paper simulation ─────────────────────────────────────────

  private checkStopLoss(lane: CandleLane, candle: Candle): void {
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

  private applySignal(lane: CandleLane, signal: Signal, candle: Candle): void {
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
        lane.state.position = {
          side: signal.side, entryPrice: entryPx,
          size: config.risk.maxPositionSizeUsd / entryPx,
          entryTime: candle.timestamp, unrealisedPnl: 0,
        };
        console.log(
          `[lane-manager] ${lane.config.strategyId}/${lane.config.timeframe}` +
          ` OPEN ${signal.side.toUpperCase()} @ ${entryPx.toFixed(2)}`,
        );
      }
    }
    if (lane.config.live) bus.emit("signal", signal);
  }

  private closePosition(lane: CandleLane, exitPx: number, reason: string): void {
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

  private markPosition(lane: CandleLane, currentPrice: number): void {
    const pos = lane.state.position;
    if (!pos) { lane.state.unrealisedPnl = 0; return; }
    const upnl = pos.side === "long"
      ? (currentPrice - pos.entryPrice) * pos.size
      : (pos.entryPrice - currentPrice) * pos.size;
    pos.unrealisedPnl        = upnl;
    lane.state.unrealisedPnl = upnl;
  }
}
