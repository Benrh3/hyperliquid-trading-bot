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

const BOTS_PATH       = resolve(process.cwd(), "config", "bots.json");
const INITIAL_EQUITY  = 1000;
const SLIPPAGE        = 0.0005;
const TAKER_FEE       = 0.00045;
const MAX_HISTORY     = 600;
const FUNDING_POLL_MS = 60_000;
const HOUR_MS         = 3_600_000;

const TF_MS: Record<string, number> = {
  "1m": 60_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
};

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface BotConfig {
  id:              string;
  strategyId:      string;
  coin:            string;
  timeframe:       string;
  active:          boolean;
  live:            boolean;
  startingEquity?: number;  // virtual USD balance at bot creation; defaults to INITIAL_EQUITY
}

export interface BotsFile {
  bots:           BotConfig[];
  fundingActive?: boolean;
}

export interface BotState {
  id:            string;
  strategyId:    string;
  displayName:   string;
  categoryLabel: string;
  coin:          string;
  timeframe:     string;
  live:          boolean;
  active:        boolean;
  status:        "running" | "paused";
  equity:        number;
  unrealisedPnl: number;
  lastPrice:     number;
  position: {
    side:          "long" | "short" | "neutral";
    entryPrice:    number;
    size:          number;
    entryTime:     number;
    unrealisedPnl: number;
  } | null;
  sessionPnl: number;
  tradeCount: number;
  startedAt:  number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface AggBuffer {
  open: number; high: number; low: number; close: number; volume: number;
  bucket: number; timestamp: number;
}

interface CoinData {
  hist1m:       Candle[];
  aggBuffers:   Map<string, AggBuffer>;   // tf → partial bar
  aggHistories: Map<string, Candle[]>;    // tf → completed bars
}

interface BotRuntime {
  config:        BotConfig;
  displayName:   string;
  categoryLabel: string;
  strategy:      Strategy;
  history:       Candle[];
  equity:        number;
  sessionPnl:    number;
  tradeCount:    number;
  position: {
    side:          "long" | "short";
    entryPrice:    number;
    size:          number;
    entryTime:     number;
    unrealisedPnl: number;
  } | null;
  unrealisedPnl: number;
  startedAt:     number;
}

interface FundingLane {
  notional:   number;
  entryPrice: number;
  openTime:   number;
  equity:     number;
  sessionPnl: number;
  periods:    number;
  lastRate:   number;
  lastBucket: number;
  pollTimer:  ReturnType<typeof setInterval>;
}

// ── BotManager ────────────────────────────────────────────────────────────────

export class BotManager {
  private bots      = new Map<string, BotRuntime>();     // id → runtime
  private coinData  = new Map<string, CoinData>();        // coin → shared data
  private coinSubs  = new Map<string, ISubscription>();   // coin → WS sub
  private fundingLane: FundingLane | null = null;

  private botsFile:     BotsFile;
  private readonly primaryCoin: string;
  private isWarming = false;

  private wsClient: SubscriptionClient | null = null;
  private info:     InfoClient;

  constructor() {
    this.primaryCoin = coins[0];
    const isTestnet  = config.exchange.network === "testnet";
    this.info        = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
    this.botsFile    = this.loadFile();
    this.buildRuntimes(this.botsFile, new Map());
  }

  // ── File persistence ─────────────────────────────────────────────────────

  private loadFile(): BotsFile {
    try {
      if (existsSync(BOTS_PATH)) {
        return JSON.parse(readFileSync(BOTS_PATH, "utf-8")) as BotsFile;
      }
    } catch { /* fall through */ }
    // Default: one candle bot per registered candle strategy on primary coin
    return {
      bots: STRATEGY_REGISTRY
        .filter((e) => e.isCandleStrategy)
        .map((e, i) => ({
          id:         `bot-${e.id}`,
          strategyId: e.id,
          coin:       this.primaryCoin,
          timeframe:  "1h",
          active:     i === 0,
          live:       i === 0,
        })),
      fundingActive: false,
    };
  }

  private saveFile(): void {
    writeFileSync(BOTS_PATH, JSON.stringify(this.botsFile, null, 2));
  }

  // ── Runtime build / rebuild ──────────────────────────────────────────────

  private buildRuntimes(file: BotsFile, oldBots: Map<string, BotRuntime>): void {
    this.bots.clear();
    for (const bc of file.bots) {
      // Build runtime for ALL bots (active and paused) so equity/position survives pause/resume
      const entry = getStrategyEntry(bc.strategyId);
      if (!entry?.isCandleStrategy || !entry.factory) continue;
      const old = oldBots.get(bc.id);
      this.bots.set(bc.id, {
        config:        bc,
        displayName:   entry.displayName,
        categoryLabel: entry.categoryLabel,
        strategy:      old ? old.strategy      : entry.factory(),
        history:       old ? old.history       : [],
        equity:        old ? old.equity        : (bc.startingEquity ?? INITIAL_EQUITY),
        sessionPnl:    old ? old.sessionPnl    : 0,
        tradeCount:    old ? old.tradeCount    : 0,
        position:      old ? old.position      : null,
        unrealisedPnl: old ? old.unrealisedPnl : 0,
        startedAt:     old ? old.startedAt     : Date.now(),
      });
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  getBotsFile(): BotsFile { return this.botsFile; }

  getBotStates(): BotState[] {
    const states: BotState[] = [];

    for (const bot of this.bots.values()) {
      const cd        = this.coinData.get(bot.config.coin);
      const lastPrice = cd && cd.hist1m.length > 0
        ? cd.hist1m[cd.hist1m.length - 1].close
        : 0;

      // Recompute unrealised P&L with the freshest price (important for paused bots
      // whose markPosition() hasn't been called since the last candle)
      let unrealisedPnl = 0;
      let position      = bot.position ? { ...bot.position } : null;
      if (position && lastPrice > 0) {
        unrealisedPnl = position.side === "long"
          ? (lastPrice - position.entryPrice) * position.size
          : (position.entryPrice - lastPrice) * position.size;
        position = { ...position, unrealisedPnl };
      }

      states.push({
        id:            bot.config.id,
        strategyId:    bot.config.strategyId,
        displayName:   bot.displayName,
        categoryLabel: bot.categoryLabel,
        coin:          bot.config.coin,
        timeframe:     bot.config.timeframe,
        live:          bot.config.live,
        active:        bot.config.active,
        status:        bot.config.active ? "running" : "paused",
        equity:        bot.equity,
        unrealisedPnl,
        lastPrice,
        position,
        sessionPnl:    bot.sessionPnl,
        tradeCount:    bot.tradeCount,
        startedAt:     bot.startedAt,
      });
    }

    if (this.fundingLane) {
      const fl = this.fundingLane;
      const msIntoHour     = Date.now() % HOUR_MS;
      const partialAccrual = fl.lastRate * fl.notional * (msIntoHour / HOUR_MS);
      const cd             = this.coinData.get(this.primaryCoin);
      const lastPrice      = cd && cd.hist1m.length > 0
        ? cd.hist1m[cd.hist1m.length - 1].close
        : fl.entryPrice;
      states.push({
        id:            "funding-basis",
        strategyId:    "funding-basis",
        displayName:   "Funding Basis",
        categoryLabel: "Market-neutral (carry)",
        coin:          this.primaryCoin,
        timeframe:     "—",
        live:          false,
        active:        true,
        status:        "running",
        equity:        fl.equity + partialAccrual,
        unrealisedPnl: partialAccrual,
        lastPrice,
        position: {
          side:          "neutral",
          entryPrice:    fl.entryPrice,
          size:          fl.notional / fl.entryPrice,
          entryTime:     fl.openTime,
          unrealisedPnl: partialAccrual,
        },
        sessionPnl: fl.sessionPnl + partialAccrual,
        tradeCount: fl.periods,
        startedAt:  fl.openTime,
      });
    }

    return states;
  }

  async applyConfig(newFile: BotsFile): Promise<void> {
    // Validate: no two active+live bots may share the same coin
    const liveCountByCoin = new Map<string, number>();
    for (const b of newFile.bots) {
      if (!b.id) throw new Error("Bot is missing an id");
      if (b.active && b.live) {
        const n = (liveCountByCoin.get(b.coin) ?? 0) + 1;
        if (n > 1) throw new Error(`Coin ${b.coin} has ${n} live bots — max 1 live bot per coin`);
        liveCountByCoin.set(b.coin, n);
      }
    }

    const oldBots          = new Map(this.bots);
    const wasFundingActive = this.botsFile.fundingActive ?? false;
    const nowFundingActive = newFile.fundingActive ?? false;

    this.botsFile = newFile;
    this.saveFile();
    this.buildRuntimes(newFile, oldBots);

    if (this.wsClient) {
      // Close all existing coin subscriptions; rebuild from scratch after warmup
      for (const sub of this.coinSubs.values()) {
        try { await sub.unsubscribe(); } catch { /* ignore */ }
      }
      this.coinSubs.clear();
      this.coinData.clear();

      const activeCoins = this.activeCanCoins(newFile);
      for (const coin of activeCoins) {
        this.coinData.set(coin, { hist1m: [], aggBuffers: new Map(), aggHistories: new Map() });
      }

      this.isWarming = true;
      try {
        await Promise.all([...activeCoins].map((c) => this.warmupCoin(c)));
      } finally {
        this.isWarming = false;
      }

      for (const coin of activeCoins) await this.subscribeToCoin(coin);

      if (!wasFundingActive && nowFundingActive) {
        await this.openFundingLane();
      } else if (wasFundingActive && !nowFundingActive) {
        this.closeFundingLane();
      }
      // If funding stays active, preserve existing lane state
    }

    console.log(
      `[bot-manager] Config applied — ${this.bots.size} active bot(s),` +
      ` funding: ${nowFundingActive ? "on" : "off"}`,
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const isTestnet = config.exchange.network === "testnet";
    const transport = new WebSocketTransport({
      isTestnet,
      reconnect: { WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
    });
    this.wsClient = new SubscriptionClient({ transport });

    const activeCoins = this.activeCanCoins(this.botsFile);
    for (const coin of activeCoins) {
      this.coinData.set(coin, { hist1m: [], aggBuffers: new Map(), aggHistories: new Map() });
    }

    this.isWarming = true;
    try {
      await Promise.all([...activeCoins].map((c) => this.warmupCoin(c)));
    } finally {
      this.isWarming = false;
    }

    for (const coin of activeCoins) await this.subscribeToCoin(coin);

    if (this.botsFile.fundingActive) await this.openFundingLane();

    console.log(
      `[bot-manager] Live — ${this.bots.size} active bot(s),` +
      ` funding: ${this.fundingLane ? "on" : "off"}`,
    );
  }

  async stop(): Promise<void> {
    for (const sub of this.coinSubs.values()) {
      try { await sub.unsubscribe(); } catch { /* ignore */ }
    }
    this.coinSubs.clear();
    if (this.fundingLane) this.closeFundingLane();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Coins that have at least one active candle-strategy bot. */
  private activeCanCoins(file: BotsFile): Set<string> {
    const s = new Set<string>();
    for (const b of file.bots) {
      if (b.active && getStrategyEntry(b.strategyId)?.isCandleStrategy) s.add(b.coin);
    }
    return s;
  }

  /** Active (non-paused) bots for a coin — used for candle dispatch and warmup. */
  private botsForCoin(coin: string): BotRuntime[] {
    const out: BotRuntime[] = [];
    for (const bot of this.bots.values()) {
      if (bot.config.coin === coin && bot.config.active) out.push(bot);
    }
    return out;
  }

  // ── Coin subscriptions ───────────────────────────────────────────────────

  private async subscribeToCoin(coin: string): Promise<void> {
    if (!this.wsClient || this.coinSubs.has(coin)) return;
    const sub = await this.wsClient.candle(
      { coin, interval: "1m" },
      (evt) => this.on1mCandle(coin, evt),
    );
    this.coinSubs.set(coin, sub);
    console.log(`[bot-manager] Subscribed to ${coin}/1m`);
  }

  // ── Warmup ───────────────────────────────────────────────────────────────

  private async warmupCoin(coin: string): Promise<void> {
    const cd       = this.coinData.get(coin);
    const coinBots = this.botsForCoin(coin).filter((b) => b.config.active);
    if (!cd || coinBots.length === 0) return;

    const uniqueTfs = new Set(coinBots.map((b) => b.config.timeframe));

    cd.hist1m = await this.fetchHistory(coin, "1m");
    for (const tf of uniqueTfs) {
      if (tf === "1m") continue;
      cd.aggHistories.set(tf, await this.fetchHistory(coin, tf));
    }

    for (const bot of coinBots) {
      const hist =
        bot.config.timeframe === "1m"
          ? cd.hist1m
          : (cd.aggHistories.get(bot.config.timeframe) ?? []);
      bot.history = hist.slice();
      for (let i = 0; i < hist.length; i++) {
        bot.strategy.onCandle(hist[i], hist.slice(0, i + 1));
      }
      console.log(
        `[bot-manager] Warmed ${bot.config.id} (${coin}/${bot.config.timeframe}) — ${hist.length} candles`,
      );
    }
  }

  private async fetchHistory(coin: string, tf: string): Promise<Candle[]> {
    try {
      const tfMs      = TF_MS[tf] ?? 3_600_000;
      const endTime   = Date.now();
      const startTime = endTime - 500 * tfMs;
      const raw       = await this.info.candleSnapshot({
        coin,
        interval:  tf as "1m",
        startTime,
        endTime,
      });
      const candles: Candle[] = raw.map((c) => ({
        coin,
        timestamp: c.t,
        open:   +c.o,
        high:   +c.h,
        low:    +c.l,
        close:  +c.c,
        volume: +c.v,
      }));
      console.log(`[bot-manager] Fetched ${candles.length} ${coin}/${tf} candles`);
      return candles;
    } catch (e) {
      console.error(`[bot-manager] History fetch failed (${coin}/${tf}):`, (e as Error).message);
      return [];
    }
  }

  // ── Live 1m candle processing ────────────────────────────────────────────

  private on1mCandle(coin: string, evt: CandleWsEvent): void {
    if (this.isWarming) return;
    const cd = this.coinData.get(coin);
    if (!cd) return;

    const candle: Candle = {
      coin,
      timestamp: evt.t,
      open:   +evt.o,
      high:   +evt.h,
      low:    +evt.l,
      close:  +evt.c,
      volume: +evt.v,
    };

    const idx   = cd.hist1m.findIndex((c) => c.timestamp === candle.timestamp);
    const isNew = idx < 0;

    if (!isNew) {
      cd.hist1m[idx] = candle;
      this.updateAggClose(coin, cd, candle);
      for (const bot of this.botsForCoin(coin)) {
        if (bot.config.timeframe === "1m") this.markPosition(bot, candle.close);
      }
      return;
    }

    cd.hist1m.push(candle);
    if (cd.hist1m.length > MAX_HISTORY) cd.hist1m.shift();

    for (const bot of this.botsForCoin(coin)) {
      if (bot.config.timeframe !== "1m") continue;
      this.checkStopLoss(bot, candle);
      bot.history.push(candle);
      if (bot.history.length > MAX_HISTORY) bot.history.shift();
      const signal = bot.strategy.onCandle(candle, bot.history.slice());
      if (signal) this.applySignal(bot, signal, candle);
      this.markPosition(bot, candle.close);
    }

    for (const [tf, tfMs] of [["1h", TF_MS["1h"]], ["4h", TF_MS["4h"]]] as [string, number][]) {
      this.aggregate(coin, cd, candle, tf, tfMs);
    }
  }

  private updateAggClose(coin: string, cd: CoinData, candle: Candle): void {
    for (const buf of cd.aggBuffers.values()) {
      buf.high  = Math.max(buf.high, candle.high);
      buf.low   = Math.min(buf.low,  candle.low);
      buf.close = candle.close;
    }
    for (const bot of this.botsForCoin(coin)) {
      if (bot.config.timeframe !== "1m") this.markPosition(bot, candle.close);
    }
  }

  private aggregate(
    coin: string,
    cd: CoinData,
    candle: Candle,
    tf: string,
    tfMs: number,
  ): void {
    const bucket = Math.floor(candle.timestamp / tfMs);
    const buf    = cd.aggBuffers.get(tf);

    if (!buf) {
      cd.aggBuffers.set(tf, {
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

    // Bucket completed — dispatch completed bar to matching bots
    const completed: Candle = {
      coin,
      timestamp: buf.timestamp,
      open: buf.open, high: buf.high, low: buf.low, close: buf.close, volume: buf.volume,
    };

    const hist = cd.aggHistories.get(tf) ?? [];
    hist.push(completed);
    if (hist.length > MAX_HISTORY) hist.shift();
    cd.aggHistories.set(tf, hist);

    for (const bot of this.botsForCoin(coin)) {
      if (bot.config.timeframe !== tf) continue;
      this.checkStopLoss(bot, completed);
      bot.history.push(completed);
      if (bot.history.length > MAX_HISTORY) bot.history.shift();
      const signal = bot.strategy.onCandle(completed, bot.history.slice());
      if (signal) this.applySignal(bot, signal, completed);
      this.markPosition(bot, completed.close);
    }

    cd.aggBuffers.set(tf, {
      open: candle.open, high: candle.high, low: candle.low,
      close: candle.close, volume: candle.volume,
      bucket, timestamp: bucket * tfMs,
    });
  }

  // ── Bot paper simulation ─────────────────────────────────────────────────

  private checkStopLoss(bot: BotRuntime, candle: Candle): void {
    const pos = bot.position;
    if (!pos) return;
    const stopPct = config.risk.stopLossPercent;
    const loss =
      pos.side === "long"
        ? (pos.entryPrice - candle.low)  / pos.entryPrice * 100
        : (candle.high - pos.entryPrice) / pos.entryPrice * 100;
    if (loss < stopPct) return;
    const exitPx =
      pos.side === "long"
        ? pos.entryPrice * (1 - stopPct / 100) * (1 - SLIPPAGE)
        : pos.entryPrice * (1 + stopPct / 100) * (1 + SLIPPAGE);
    this.closePosition(bot, exitPx, `Stop-loss ${loss.toFixed(1)}%`);
  }

  private applySignal(bot: BotRuntime, signal: Signal, candle: Candle): void {
    if (signal.side === "close") {
      if (!bot.position) return;
      const exitPx =
        bot.position.side === "long"
          ? candle.close * (1 - SLIPPAGE)
          : candle.close * (1 + SLIPPAGE);
      this.closePosition(bot, exitPx, signal.reason);
    } else {
      if (bot.position && bot.position.side !== signal.side) {
        const exitPx =
          bot.position.side === "long"
            ? candle.close * (1 - SLIPPAGE)
            : candle.close * (1 + SLIPPAGE);
        this.closePosition(bot, exitPx, `Reversed to ${signal.side}`);
      }
      if (!bot.position) {
        const entryPx =
          signal.side === "long"
            ? candle.close * (1 + SLIPPAGE)
            : candle.close * (1 - SLIPPAGE);
        bot.position = {
          side:          signal.side,
          entryPrice:    entryPx,
          size:          config.risk.maxPositionSizeUsd / entryPx,
          entryTime:     candle.timestamp,
          unrealisedPnl: 0,
        };
        console.log(
          `[bot-manager] ${bot.config.id}/${bot.config.coin}/${bot.config.timeframe}` +
          ` OPEN ${signal.side.toUpperCase()} @ ${entryPx.toFixed(2)}`,
        );
      }
    }
    if (bot.config.live) bus.emit("signal", signal);
  }

  private closePosition(bot: BotRuntime, exitPx: number, reason: string): void {
    const pos = bot.position;
    if (!pos) return;
    const pnl =
      pos.side === "long"
        ? (exitPx - pos.entryPrice) * pos.size
        : (pos.entryPrice - exitPx) * pos.size;
    bot.equity        += pnl;
    bot.sessionPnl    += pnl;
    bot.tradeCount++;
    bot.position       = null;
    bot.unrealisedPnl  = 0;
    console.log(
      `[bot-manager] ${bot.config.id}/${bot.config.coin}/${bot.config.timeframe}` +
      ` CLOSE @ ${exitPx.toFixed(2)} PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} (${reason})`,
    );
  }

  private markPosition(bot: BotRuntime, currentPrice: number): void {
    const pos = bot.position;
    if (!pos) { bot.unrealisedPnl = 0; return; }
    const upnl =
      pos.side === "long"
        ? (currentPrice - pos.entryPrice) * pos.size
        : (pos.entryPrice - currentPrice) * pos.size;
    pos.unrealisedPnl = upnl;
    bot.unrealisedPnl = upnl;
  }

  // ── Funding lane ─────────────────────────────────────────────────────────

  private async openFundingLane(): Promise<void> {
    if (this.fundingLane) return;

    // Resolve entry price: prefer primary coin's live hist1m, fall back to a fresh fetch
    let entryPrice = 0;
    const cd = this.coinData.get(this.primaryCoin);
    if (cd && cd.hist1m.length > 0) {
      entryPrice = cd.hist1m[cd.hist1m.length - 1].close;
    } else {
      const candles = await this.fetchHistory(this.primaryCoin, "1m");
      if (candles.length > 0) entryPrice = candles[candles.length - 1].close;
    }

    if (entryPrice <= 0) {
      console.warn("[bot-manager] Funding lane: no price yet — retrying in 5 s");
      setTimeout(() => void this.openFundingLane(), 5_000);
      return;
    }

    const now        = Date.now();
    const entryFees  = 2 * TAKER_FEE * INITIAL_EQUITY;
    this.fundingLane = {
      notional:   INITIAL_EQUITY,
      entryPrice,
      openTime:   now,
      equity:     INITIAL_EQUITY - entryFees,
      sessionPnl: -entryFees,
      periods:    0,
      lastRate:   0,
      lastBucket: Math.floor(now / HOUR_MS),
      pollTimer:  setInterval(() => void this.pollFunding(), FUNDING_POLL_MS),
    };
    console.log(
      `[bot-manager] Funding lane OPEN @ $${entryPrice.toFixed(2)}` +
      ` notional=$${INITIAL_EQUITY} entry fees=$${entryFees.toFixed(4)}`,
    );
    void this.pollFunding();
  }

  private closeFundingLane(): void {
    const fl = this.fundingLane;
    if (!fl) return;
    clearInterval(fl.pollTimer);
    const exitFees  = 2 * TAKER_FEE * fl.notional;
    fl.equity      -= exitFees;
    fl.sessionPnl  -= exitFees;
    console.log(
      `[bot-manager] Funding lane CLOSE` +
      ` periods=${fl.periods} netPnl=${fl.sessionPnl >= 0 ? "+" : ""}${fl.sessionPnl.toFixed(4)}`,
    );
    this.fundingLane = null;
  }

  // ── Per-bot surgical operations ──────────────────────────────────────────

  async addBot(input: {
    strategyId:      string;
    coin:            string;
    timeframe:       string;
    live?:           boolean;
    startingEquity?: number;
  }): Promise<string> {
    const coin       = input.coin.trim().toUpperCase();
    const timeframe  = input.timeframe;
    const live       = input.live ?? false;
    const equity     = Math.max(1, input.startingEquity ?? INITIAL_EQUITY);

    if (!["1m", "1h", "4h"].includes(timeframe)) {
      throw new Error(`Invalid timeframe: ${timeframe}`);
    }
    const entry = getStrategyEntry(input.strategyId);
    if (!entry?.isCandleStrategy || !entry.factory) {
      throw new Error(`Unknown candle strategy: ${input.strategyId}`);
    }
    if (live) {
      const conflict = this.botsFile.bots.find(
        (b) => b.coin === coin && b.active && b.live,
      );
      if (conflict) throw new Error(`Coin ${coin} already has a live bot`);
    }

    const id = "bot-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const bc: BotConfig = { id, strategyId: input.strategyId, coin, timeframe, active: true, live, startingEquity: equity };

    this.botsFile.bots.push(bc);
    this.saveFile();

    const runtime: BotRuntime = {
      config:        bc,
      displayName:   entry.displayName,
      categoryLabel: entry.categoryLabel,
      strategy:      entry.factory(),
      history:       [],
      equity,
      sessionPnl:    0,
      tradeCount:    0,
      position:      null,
      unrealisedPnl: 0,
      startedAt:     Date.now(),
    };
    this.bots.set(id, runtime);

    if (this.wsClient) {
      if (!this.coinSubs.has(coin)) {
        if (!this.coinData.has(coin)) {
          this.coinData.set(coin, { hist1m: [], aggBuffers: new Map(), aggHistories: new Map() });
        }
        this.isWarming = true;
        try { await this.warmupCoin(coin); } finally { this.isWarming = false; }
        await this.subscribeToCoin(coin);
      } else {
        await this.warmupSingleBot(runtime);
      }
    }

    console.log(`[bot-manager] Added ${id} (${input.strategyId}/${coin}/${timeframe} equity=$${equity})`);
    return id;
  }

  async pauseBot(id: string): Promise<void> {
    const bc = this.botsFile.bots.find((b) => b.id === id);
    if (!bc || !bc.active) return;
    bc.active = false;
    this.saveFile();
    const runtime = this.bots.get(id);
    if (runtime) runtime.config.active = false;
    // Keep subscription open so lastPrice stays fresh; close only when last bot on coin is deleted
    console.log(`[bot-manager] Paused ${id} (${bc.coin}/${bc.timeframe})`);
  }

  async resumeBot(id: string): Promise<void> {
    const bc = this.botsFile.bots.find((b) => b.id === id);
    if (!bc || bc.active) return;
    bc.active = true;
    this.saveFile();
    const runtime = this.bots.get(id);
    if (!runtime) return;
    runtime.config.active = true;

    if (!this.wsClient) return;

    if (!this.coinSubs.has(bc.coin)) {
      // Coin was never subscribed (e.g. bot added while engine was pausing)
      if (!this.coinData.has(bc.coin)) {
        this.coinData.set(bc.coin, { hist1m: [], aggBuffers: new Map(), aggHistories: new Map() });
      }
      this.isWarming = true;
      try {
        await this.warmupCoin(bc.coin);
      } finally {
        this.isWarming = false;
      }
      await this.subscribeToCoin(bc.coin);
    } else {
      // Coin already has a live feed — just rebuild this bot's strategy state
      await this.warmupSingleBot(runtime);
    }
    console.log(`[bot-manager] Resumed ${id} (${bc.coin}/${bc.timeframe})`);
  }

  async deleteBot(id: string): Promise<void> {
    const idx = this.botsFile.bots.findIndex((b) => b.id === id);
    if (idx === -1) return;
    const bc = this.botsFile.bots[idx];
    this.botsFile.bots.splice(idx, 1);
    this.saveFile();
    this.bots.delete(id);
    // Close subscription only when no bots remain on this coin
    const coinStillUsed = this.botsFile.bots.some((b) => b.coin === bc.coin);
    if (!coinStillUsed) {
      const sub = this.coinSubs.get(bc.coin);
      if (sub) {
        try { await sub.unsubscribe(); } catch { /* ignore */ }
        this.coinSubs.delete(bc.coin);
        this.coinData.delete(bc.coin);
      }
    }
    console.log(`[bot-manager] Deleted ${id} (${bc.coin}/${bc.timeframe})`);
  }

  private async warmupSingleBot(bot: BotRuntime): Promise<void> {
    const cd  = this.coinData.get(bot.config.coin);
    const tf  = bot.config.timeframe;
    const entry = getStrategyEntry(bot.config.strategyId);
    if (!cd || !entry?.factory) return;

    let hist: Candle[];
    if (tf === "1m") {
      hist = cd.hist1m;
    } else {
      if (!cd.aggHistories.has(tf)) {
        cd.aggHistories.set(tf, await this.fetchHistory(bot.config.coin, tf));
      }
      hist = cd.aggHistories.get(tf) ?? [];
    }
    // Fresh strategy instance so indicator state is accurate after missed candles
    bot.strategy = entry.factory();
    bot.history  = hist.slice();
    for (let i = 0; i < hist.length; i++) {
      bot.strategy.onCandle(hist[i], hist.slice(0, i + 1));
    }
    console.log(`[bot-manager] Warmed ${bot.config.id} — ${hist.length} ${tf} candles`);
  }

  private async pollFunding(): Promise<void> {
    const fl = this.fundingLane;
    if (!fl) return;
    try {
      const [meta, assetCtxs] = await this.info.metaAndAssetCtxs();
      const idx = meta.universe.findIndex((u) => u.name === this.primaryCoin);
      if (idx === -1) return;
      const rate = parseFloat(assetCtxs[idx].funding);
      fl.lastRate = rate;
      const currentBucket = Math.floor(Date.now() / HOUR_MS);
      if (currentBucket > fl.lastBucket) {
        const n         = currentBucket - fl.lastBucket;
        const earned    = rate * fl.notional * n;
        fl.equity      += earned;
        fl.sessionPnl  += earned;
        fl.periods     += n;
        fl.lastBucket   = currentBucket;
        console.log(
          `[bot-manager] Funding accrual ×${n}` +
          ` rate=${(rate * 100).toFixed(4)}% earned=${earned >= 0 ? "+" : ""}${earned.toFixed(4)}`,
        );
      }
    } catch (e) {
      console.error("[bot-manager] Funding poll failed:", (e as Error).message);
    }
  }
}
