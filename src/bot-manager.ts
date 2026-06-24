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
import { computePositionSize } from "./position-sizing.js";
import { STRATEGY_REGISTRY, getStrategyEntry } from "./strategy/registry.js";
import { CrossVenueFundingBasis } from "./cross-venue-funding.js";
import type { ExecutionMode } from "./cross-venue-funding.js";
import type { Strategy } from "./strategy/base.js";
import type { Candle, Signal } from "./events.js";
import type { Venue } from "./venue.js";
import type { Logger } from "./logger.js";
import type { CvStateStore } from "./cv-state-store.js";

const BOTS_PATH      = resolve(process.cwd(), "config", "bots.json");
const INITIAL_EQUITY = 1000;
const SLIPPAGE       = 0.0005;
const MAX_HISTORY    = 600;

const TF_MS: Record<string, number> = {
  "1m":  60_000,
  "5m":  300_000,
  "15m": 900_000,
  "1h":  3_600_000,
  "4h":  14_400_000,
  "1d":  86_400_000,
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
  notional?:       number;  // USD notional for cross-venue bots; defaults to INITIAL_EQUITY
}

export interface BotsFile {
  bots: BotConfig[];
  // fundingActive removed — single-venue FundingLane is deprecated
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
  status:        "running" | "paused" | "error";
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
  sessionPnl:       number;
  tradeCount:       number;
  /** Durable realised P&L from the trades table — survives restarts. */
  realisedPnl:      number;
  /** Durable trade count from the trades table — survives restarts. */
  realisedTrades:   number;
  startedAt:        number;
  error?:           string;
  /** Funding-basis only: human-readable description of current legs. */
  fundingDirection?: string;
  /** Funding-basis only: number of direction flips since open. */
  fundingFlips?:     number;
  /** Cross-venue only: ordered legs [shortLeg, longLeg]. */
  crossVenueLegs?:   Array<{ venue: string; side: "long" | "short" }>;
  /** Cross-venue only: gross funding collected before fees (USD). */
  capturedFunding?:  number;
  /** Cross-venue only: current funding spread rate (decimal per hour). */
  currentSpread?:    number;
  /** Cross-venue only: current execution mode. */
  executionMode?:    "paper" | "live";
  /** Cross-venue only: average hours between leg-direction flips. */
  avgFlipFrequencyHours?: number;
  /** Cross-venue only: average hold duration per direction in hours. */
  avgHeldDurationHours?:  number;
  /** Cross-venue only: total funding captured over rolling 7-day window as % of notional. */
  rolling7dCapturePct?:   number;
  /** Cross-venue only: human-readable reason the daily-loss circuit breaker tripped. */
  crossVenuePausedReason?: string;
  /** Set when the last reconcile cycle found a mismatch vs the exchange. */
  hadRecentMismatch?:  boolean;
  /** Human-readable description of the most recent reconcile event. */
  lastReconcileEvent?: string;
}

// ── Orphaned position (on exchange, no live bot owns it) ──────────────────────

export interface OrphanedPosition {
  coin:          string;
  side:          "long" | "short";
  size:          number;
  entryPrice:    number;
  markPrice:     number;
  unrealisedPnl: number;
  detectedAt:    number; // epoch ms
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
  /** null for cross-venue bots which have their own poll loop */
  strategy:      Strategy | null;
  /** Set for cross-venue-funding-basis bots */
  crossVenue?:   CrossVenueFundingBasis;
  history:       Candle[];
  equity:        number;
  sessionPnl:    number;
  tradeCount:    number;
  /** Durable realised P&L from the trades table — survives restarts. */
  realisedPnl:   number;
  /** Durable trade count from the trades table — survives restarts. */
  realisedTrades: number;
  position: {
    side:          "long" | "short";
    entryPrice:    number;
    size:          number;
    entryTime:     number;
    unrealisedPnl: number;
  } | null;
  unrealisedPnl:      number;
  startedAt:          number;
  error?:             string;
  hadRecentMismatch?: boolean;
  lastReconcileEvent?: string;
  /**
   * Set to true at the very start of deleteBot() — before any async cleanup.
   * Every in-flight async method (executeLiveSignal/Open/Close, reconcileBot)
   * checks this flag at each await point and short-circuits if true, preventing
   * the deleted bot from placing any further exchange orders.
   */
  deleted?: boolean;
}

// ── BotManager ────────────────────────────────────────────────────────────────

/** How long an orphaned position can exist before it is auto-closed (24 h). */
const ORPHAN_AUTO_CLOSE_MS = 24 * 60 * 60_000;
/** Reconcile every 60 seconds. */
const RECONCILE_INTERVAL_MS = 60_000;
/** After this many ms a "recent mismatch" indicator clears itself. */
const MISMATCH_STALE_MS = 5 * 60_000;

export class BotManager {
  private bots      = new Map<string, BotRuntime>();
  private coinData  = new Map<string, CoinData>();
  private coinSubs  = new Map<string, ISubscription>();

  private botsFile: BotsFile;
  private isWarming = false;

  private wsClient: SubscriptionClient | null = null;
  private info:     InfoClient;
  /** HL venue for live candle-bot trading and cross-venue rate reads. */
  private readonly venue:     Venue | undefined;
  /** dYdX venue injected for cross-venue bots. */
  private readonly dydxVenue: Venue | undefined;
  /** Logger used for cross-venue flip event persistence. */
  private readonly logger:    Logger | undefined;
  /** SQLite persistence for cross-venue bot state. */
  private readonly cvStateStore: CvStateStore | undefined;
  /** Orphaned positions on the exchange that no live bot claims. key=coin */
  private orphans = new Map<string, OrphanedPosition>();
  /** Reconcile loop timer handle. */
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(venue?: Venue, dydxVenue?: Venue, logger?: Logger, cvStateStore?: CvStateStore) {
    this.venue        = venue;
    this.dydxVenue    = dydxVenue;
    this.logger       = logger;
    this.cvStateStore = cvStateStore;
    const isTestnet = config.exchange.network === "testnet";
    this.info        = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
    this.botsFile    = this.loadFile();
    this.buildRuntimes(this.botsFile, new Map());
  }

  // ── File persistence ─────────────────────────────────────────────────────

  private loadFile(): BotsFile {
    try {
      if (existsSync(BOTS_PATH)) {
        const raw = JSON.parse(readFileSync(BOTS_PATH, "utf-8")) as BotsFile & { fundingActive?: boolean };
        // ── Migration: remove deprecated fundingActive and single-venue funding-basis bots ──
        const hadFundingActive = raw.fundingActive === true;
        const hadFundingBasisBot = raw.bots.some((b) => b.strategyId === "funding-basis");
        if (hadFundingActive || hadFundingBasisBot) {
          console.log(
            "[bot-manager] Migrating bots.json: removing deprecated single-venue FundingBasis " +
            "(replaced by CrossVenueFundingBasis). Re-add it via the Bots page if needed.",
          );
          raw.bots = raw.bots.filter((b) => b.strategyId !== "funding-basis");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (raw as any)["fundingActive"];
          writeFileSync(BOTS_PATH, JSON.stringify({ bots: raw.bots }, null, 2));
        }
        return { bots: raw.bots };
      }
    } catch { /* fall through */ }
    // Default: one candle bot per registered candle strategy on primary coin
    return {
      bots: STRATEGY_REGISTRY
        .filter((e) => e.isCandleStrategy)
        .map((e, i) => ({
          id:         `bot-${e.id}`,
          strategyId: e.id,
          coin:       coins[0],
          timeframe:  "1h",
          active:     i === 0,
          live:       i === 0,
        })),
    };
  }

  private saveFile(): void {
    writeFileSync(BOTS_PATH, JSON.stringify(this.botsFile, null, 2));
  }

  // ── Runtime build / rebuild ──────────────────────────────────────────────

  private buildRuntimes(file: BotsFile, oldBots: Map<string, BotRuntime>): void {
    this.bots.clear();
    for (const bc of file.bots) {
      const old = oldBots.get(bc.id);
      // Seed durable stats from the trades table (strategy+coin key).
      // NOTE: two bots with the same strategy+coin would collide; if that's
      // ever needed, add a bot_id column to the trades table.
      const durableStats = this.logger?.getBotRealisedStats(bc.strategyId, bc.coin, bc.id);
      const realisedPnl    = old?.realisedPnl    ?? durableStats?.realisedPnl    ?? 0;
      const realisedTrades = old?.realisedTrades  ?? durableStats?.tradeCount     ?? 0;

      // ── Cross-venue bots ─────────────────────────────────────────────────
      if (bc.strategyId === "cross-venue-funding-basis") {
        const notional = bc.notional ?? INITIAL_EQUITY;
        // Reuse existing instance to preserve accumulated state; otherwise rehydrate from SQLite
        const cv = old?.crossVenue ?? new CrossVenueFundingBasis(
          this.venue!, this.dydxVenue!, bc.coin, notional, this.logger,
          this.cvStateStore, bc.id,
        );
        // Sync mode from config
        cv.setExecutionMode(bc.live ? "live" : "paper");
        this.bots.set(bc.id, {
          config:        bc,
          displayName:   "Cross-Venue Funding Basis",
          categoryLabel: `HL ↔ dYdX · ${bc.coin}`,
          strategy:      null,
          crossVenue:    cv,
          history:       [],
          equity:        old?.equity ?? notional,
          sessionPnl:    old?.sessionPnl ?? 0,
          tradeCount:    old?.tradeCount ?? 0,
          realisedPnl,
          realisedTrades,
          position:      null,
          unrealisedPnl: 0,
          startedAt:     old?.startedAt ?? Date.now(),
        });
        continue;
      }

      // ── Candle-strategy bots ─────────────────────────────────────────────
      const entry = getStrategyEntry(bc.strategyId);
      if (!entry?.isCandleStrategy || !entry.factory) continue;
      this.bots.set(bc.id, {
        config:        bc,
        displayName:   entry.displayName,
        categoryLabel: entry.categoryLabel,
        strategy:      old?.strategy ?? entry.factory(),
        history:       old?.history       ?? [],
        equity:        old?.equity        ?? (bc.startingEquity ?? INITIAL_EQUITY),
        sessionPnl:    old?.sessionPnl    ?? 0,
        tradeCount:    old?.tradeCount    ?? 0,
        realisedPnl,
        realisedTrades,
        position:      old?.position      ?? null,
        unrealisedPnl: old?.unrealisedPnl ?? 0,
        startedAt:     old?.startedAt     ?? Date.now(),
      });
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  getBotsFile(): BotsFile { return this.botsFile; }

  getOrphanedPositions(): OrphanedPosition[] {
    return [...this.orphans.values()];
  }

  getBotStates(): BotState[] {
    const states: BotState[] = [];

    for (const bot of this.bots.values()) {
      // ── Cross-venue bots: delegate entirely to CrossVenueFundingBasis ─────
      if (bot.crossVenue) {
        const cvState = bot.crossVenue.getBotState();
        // Override id/coin/active from BotConfig so pause/resume state is authoritative
        states.push({
          ...cvState,
          id:     bot.config.id,
          coin:   bot.config.coin,
          active: bot.config.active,
          status: !bot.config.active ? "paused" : cvState.status,
        });
        continue;
      }

      // ── Candle-strategy bots ──────────────────────────────────────────────
      const cd        = this.coinData.get(bot.config.coin);
      const lastPrice = cd && cd.hist1m.length > 0
        ? cd.hist1m[cd.hist1m.length - 1].close
        : 0;

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
        status:        bot.error ? "error" : bot.config.active ? "running" : "paused",
        equity:        bot.equity,
        unrealisedPnl,
        lastPrice,
        position,
        sessionPnl:    bot.sessionPnl,
        tradeCount:    bot.tradeCount,
        realisedPnl:   bot.realisedPnl,
        realisedTrades: bot.realisedTrades,
        startedAt:     bot.startedAt,
        error:         bot.error,
        hadRecentMismatch:  bot.hadRecentMismatch,
        lastReconcileEvent: bot.lastReconcileEvent,
      });
    }

    return states;
  }

  async applyConfig(newFile: BotsFile): Promise<void> {
    for (const b of newFile.bots) {
      if (!b.id) throw new Error("Bot is missing an id");
    }

    const oldBots = new Map(this.bots);
    // Stop cross-venue bots that are being removed
    for (const [id, old] of oldBots) {
      if (old.crossVenue && !newFile.bots.find((b) => b.id === id)) {
        old.crossVenue.stop();
      }
    }

    this.botsFile = newFile;
    this.saveFile();
    this.buildRuntimes(newFile, oldBots);

    // Start any new cross-venue bots
    for (const bot of this.bots.values()) {
      if (bot.crossVenue && !oldBots.has(bot.config.id)) {
        void bot.crossVenue.start().catch((e: Error) =>
          console.error(`[bot-manager] Cross-venue start failed ${bot.config.id}: ${e.message}`),
        );
      }
    }

    if (this.wsClient) {
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
        await Promise.all([...activeCoins].map(async (coin) => {
          try {
            await this.warmupCoin(coin);
          } catch (e) {
            const msg = (e as Error).message;
            console.error(`[bot-manager] Warmup failed for ${coin}: ${msg}`);
            this.markCoinError(coin, `Warmup failed: ${msg}`);
          }
        }));
      } finally {
        this.isWarming = false;
      }

      for (const coin of activeCoins) {
        try {
          await this.subscribeToCoin(coin);
        } catch (e) {
          const msg = (e as Error).message;
          console.error(`[bot-manager] Subscription failed for ${coin}: ${msg}`);
          this.markCoinError(coin, `Subscription failed: ${msg}`);
        }
      }
    }

    console.log(`[bot-manager] Config applied — ${this.bots.size} bot(s)`);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Start all cross-venue bots first (they poll independently)
    for (const bot of this.bots.values()) {
      if (bot.crossVenue && bot.config.active) {
        try {
          await bot.crossVenue.start();
        } catch (e) {
          console.error(`[bot-manager] Cross-venue start failed ${bot.config.id}: ${(e as Error).message}`);
          bot.error = `Start failed: ${(e as Error).message}`;
        }
      }
    }

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
      await Promise.all([...activeCoins].map(async (coin) => {
        try {
          await this.warmupCoin(coin);
        } catch (e) {
          const msg = (e as Error).message;
          console.error(`[bot-manager] Warmup failed for ${coin}: ${msg}`);
          this.markCoinError(coin, `Warmup failed: ${msg}`);
        }
      }));
    } finally {
      this.isWarming = false;
    }

    for (const coin of activeCoins) {
      try {
        await this.subscribeToCoin(coin);
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`[bot-manager] Subscription failed for ${coin}: ${msg}`);
        this.markCoinError(coin, `Subscription failed: ${msg}`);
      }
    }

    const cvCount = [...this.bots.values()].filter((b) => b.crossVenue).length;
    console.log(
      `[bot-manager] Live — ${this.bots.size} bot(s) (${cvCount} cross-venue)`,
    );

    // Start reconciliation loop — runs independently of the candle feed
    if (this.venue) {
      this.reconcileTimer = setInterval(() => void this.runReconcile(), RECONCILE_INTERVAL_MS);
      // Run an initial check shortly after startup so early mismatches are caught immediately
      setTimeout(() => void this.runReconcile(), 5_000);

      // ── Per-trade trigger (improvement 1) ─────────────────────────────────
      // In addition to the 60 s backstop, run a single-coin reconcile every time
      // a trade event fires so state drift is caught within seconds of any fill.
      // Guard against the feedback loop where "adopted_from_exchange" trade events
      // (emitted by reconcileBot itself) would immediately re-trigger a reconcile.
      bus.on("trade", (result) => {
        if (!result.success || !this.venue || this.isWarming) return;
        if (result.reason === "adopted_from_exchange") return;
        const bot = [...this.bots.values()].find(
          (b) => b.config.live && b.config.coin === result.coin && !b.crossVenue,
        );
        if (!bot) return;
        void this.reconcileBot(bot).catch((e: Error) =>
          console.error(`[reconcile] Post-trade reconcile failed for ${result.coin}: ${e.message}`),
        );
      });
    }
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
    for (const sub of this.coinSubs.values()) {
      try { await sub.unsubscribe(); } catch { /* ignore */ }
    }
    this.coinSubs.clear();
    for (const bot of this.bots.values()) {
      if (bot.crossVenue) bot.crossVenue.stop();
    }
  }

  // ── Public orphan operations ─────────────────────────────────────────────

  async closeOrphan(coin: string): Promise<void> {
    if (!this.venue) throw new Error("No venue configured");
    const orphan = this.orphans.get(coin);
    if (!orphan) throw new Error(`No orphaned position tracked for ${coin}`);
    console.log(`[reconcile] Manually closing orphan ${coin}`);
    const receipt = await this.venue.closePosition(coin);
    this.orphans.delete(coin);
    console.log(`[reconcile] Orphan ${coin} closed — txHash=${receipt.orderId} fillPx=${receipt.fillPrice}`);
    this.logger?.logEvent("reconcile", "info", `Orphan closed: ${coin}`, {
      coin, receipt, trigger: "manual",
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Coins that have at least one active candle-strategy bot (excludes cross-venue). */
  private activeCanCoins(file: BotsFile): Set<string> {
    const s = new Set<string>();
    for (const b of file.bots) {
      if (b.strategyId === "cross-venue-funding-basis") continue;
      if (b.active && getStrategyEntry(b.strategyId)?.isCandleStrategy) s.add(b.coin);
    }
    return s;
  }

  /** Active candle-strategy bots for a coin (excludes cross-venue bots). */
  private botsForCoin(coin: string): BotRuntime[] {
    const out: BotRuntime[] = [];
    for (const bot of this.bots.values()) {
      if (bot.crossVenue) continue; // cross-venue bots poll independently
      if (bot.config.coin === coin && bot.config.active) out.push(bot);
    }
    return out;
  }

  /** Mark every bot on a coin as errored so the UI surfaces the failure. */
  private markCoinError(coin: string, message: string): void {
    for (const bot of this.bots.values()) {
      if (bot.config.coin === coin) bot.error = message;
    }
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
      if (!bot.strategy) continue; // cross-venue bots have no candle strategy
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

      // Sync the previous candle's final OHLCV into bot.history before appending the new one.
      // cd.hist1m[-2] holds the final close of the just-closed candle (updated via updateAggClose
      // on every !isNew tick); bot.history still has the first-tick (open) value for that candle.
      // Without this, RSI/MACD/BB are computed on open prices instead of close prices.
      if (bot.history.length > 0 && cd.hist1m.length >= 2) {
        const finalPrev = cd.hist1m[cd.hist1m.length - 2];
        if (bot.history[bot.history.length - 1].timestamp === finalPrev.timestamp) {
          bot.history[bot.history.length - 1] = finalPrev;
        }
      }

      bot.history.push(candle);
      if (bot.history.length > MAX_HISTORY) bot.history.shift();
      const signal = bot.strategy!.onCandle(candle, bot.history.slice());
      if (signal) this.applySignal(bot, signal, candle);
      this.markPosition(bot, candle.close);
    }

    // Aggregate only the timeframes that active bots on this coin actually use
    const neededTfs = new Set(this.botsForCoin(coin).map(b => b.config.timeframe).filter(tf => tf !== "1m"));
    for (const tf of neededTfs) {
      const tfMs = TF_MS[tf];
      if (tfMs) this.aggregate(coin, cd, candle, tf, tfMs);
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
      const signal = bot.strategy!.onCandle(completed, bot.history.slice());
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
    const reason = `Stop-loss ${loss.toFixed(1)}%`;
    if (bot.config.live) {
      // Fire-and-forget: venue fetches its own mark price, works for any coin
      void this.executeLiveClose(bot, reason).catch((err: Error) =>
        console.error(`[bot-manager] LIVE stop-loss close failed ${bot.config.id}: ${err.message}`),
      );
    } else {
      const exitPx =
        pos.side === "long"
          ? pos.entryPrice * (1 - stopPct / 100) * (1 - SLIPPAGE)
          : pos.entryPrice * (1 + stopPct / 100) * (1 + SLIPPAGE);
      this.paperClosePosition(bot, exitPx, reason);
    }
  }

  private applySignal(bot: BotRuntime, signal: Signal, candle: Candle): void {
    // Signal counter and logger always see every bot's signals.
    // Always paper:true for the bus — BotManager handles its own execution
    // in executeLiveSignal(). Without this, the legacy Executor also hears
    // the signal via RiskManager → signal:approved and double-executes,
    // causing "failed, qty 0" rows in the trade log.
    bus.emit("signal", { ...signal, paper: true });

    if (bot.config.live) {
      // Real execution path — async, venue fetches its own price for any coin.
      // State updates (bot.position, equity) happen ONLY after confirmed fill.
      void this.executeLiveSignal(bot, signal, candle).catch((err: Error) =>
        console.error(`[bot-manager] LIVE signal failed ${bot.config.id}: ${err.message}`),
      );
      return;
    }

    // ── Paper simulation path ─────────────────────────────────────────────
    if (signal.side === "close") {
      if (!bot.position) return;
      const exitPx =
        bot.position.side === "long"
          ? candle.close * (1 - SLIPPAGE)
          : candle.close * (1 + SLIPPAGE);
      this.paperClosePosition(bot, exitPx, signal.reason);
    } else {
      if (bot.position && bot.position.side !== signal.side) {
        const exitPx =
          bot.position.side === "long"
            ? candle.close * (1 - SLIPPAGE)
            : candle.close * (1 + SLIPPAGE);
        this.paperClosePosition(bot, exitPx, `Reversed to ${signal.side}`);
      }
      if (!bot.position) {
        const entryPx = signal.side === "long"
          ? candle.close * (1 + SLIPPAGE)
          : candle.close * (1 - SLIPPAGE);
        // Paper sizing uses bot.equity as the "account" so maths mirrors live behaviour
        const sizing  = computePositionSize(bot.equity, entryPx);
        bot.position  = {
          side:          signal.side,
          entryPrice:    entryPx,
          size:          sizing.sizeBase,
          entryTime:     candle.timestamp,
          unrealisedPnl: 0,
        };
        console.log(
          `[bot-manager] ${bot.config.id}/${bot.config.coin}/${bot.config.timeframe}` +
          ` PAPER OPEN ${signal.side.toUpperCase()} @ ${entryPx.toFixed(2)}` +
          ` notional=$${sizing.notionalUsd.toFixed(2)} lev=${sizing.leverage.toFixed(2)}x risk=$${sizing.dollarRisk.toFixed(2)}`,
        );
      }
    }
  }

  /** Paper-only position close — updates equity/tradeCount in memory, no exchange call. */
  private paperClosePosition(bot: BotRuntime, exitPx: number, reason: string): void {
    const pos = bot.position;
    if (!pos) return;
    const pnl =
      pos.side === "long"
        ? (exitPx - pos.entryPrice) * pos.size
        : (pos.entryPrice - exitPx) * pos.size;
    bot.equity          += pnl;
    bot.sessionPnl      += pnl;
    bot.tradeCount++;
    bot.realisedPnl     += pnl;
    bot.realisedTrades++;
    bot.position         = null;
    bot.unrealisedPnl    = 0;
    console.log(
      `[bot-manager] ${bot.config.id}/${bot.config.coin}/${bot.config.timeframe}` +
      ` PAPER CLOSE @ ${exitPx.toFixed(2)} PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} (${reason})`,
    );
  }

  // ── Live execution (real exchange orders via Venue) ────────────────────────

  /**
   * Orchestrates the full live-signal flow: close existing position if needed,
   * then open a new one. Called fire-and-forget; all state updates happen here
   * only after a confirmed exchange response.
   */
  private async executeLiveSignal(bot: BotRuntime, signal: Signal, candle: Candle): Promise<void> {
    if (bot.deleted) return; // bot was deleted while we were queued
    if (!this.venue) {
      console.warn(
        `[bot-manager] ${bot.config.id} is LIVE but no venue configured — ` +
        `skipping exchange order (set HL_PRIVATE_KEY to enable live trading)`,
      );
      return;
    }

    if (signal.side === "close") {
      if (!bot.position) return;
      await this.executeLiveClose(bot, signal.reason);
      return;
    }

    // Reversal: close existing first, then open the opposite side
    if (bot.position && bot.position.side !== signal.side) {
      await this.executeLiveClose(bot, `Reversed to ${signal.side}`);
      if (bot.deleted) return; // deleted during the close await
      if (bot.position) {
        return; // close failed — abort reversal
      }
    }

    if (!bot.position) {
      if (bot.deleted) return; // deleted between close and open
      await this.executeLiveOpen(bot, signal, candle.timestamp);
    }
  }

  private async executeLiveOpen(bot: BotRuntime, signal: Signal, candleTs: number): Promise<void> {
    if (bot.deleted || signal.side === "close") return;
    const coin = bot.config.coin;
    const tag  = `${bot.config.id}/${coin}/${bot.config.timeframe}`;
    try {
      const accountEquity = (await this.venue!.getAccountEquity()) ?? bot.equity;
      if (bot.deleted) return; // deleted while awaiting equity
      const markPrice = (await this.venue!.getMarkPrice(coin)) ?? 0;
      if (bot.deleted) return; // deleted while awaiting mark price
      if (markPrice === 0) throw new Error(`No mark price for ${coin}`);

      const sizing  = computePositionSize(accountEquity, markPrice);
      const receipt = await this.venue!.openPosition(coin, signal.side, sizing.notionalUsd);

      if (bot.deleted) {
        // The bot was deleted while openPosition was in flight. The exchange now has a
        // position that nobody owns — register it as an orphan immediately.
        console.warn(
          `[bot-manager] ${tag} Bot deleted mid open-order flight — ` +
          `position ${signal.side} ${receipt.fillSize} ${coin} @ $${receipt.fillPrice} is now an orphan`,
        );
        void this.checkOrphanOnDelete(coin);
        return;
      }

      bot.position = {
        side:          signal.side,
        entryPrice:    receipt.fillPrice,
        size:          receipt.fillSize,
        entryTime:     candleTs,
        unrealisedPnl: 0,
      };
      console.log(
        `[bot-manager] ${tag} LIVE OPEN ${signal.side.toUpperCase()}` +
        ` oid=${receipt.orderId} fillPx=${receipt.fillPrice.toFixed(4)} sz=${receipt.fillSize}` +
        ` notional=$${sizing.notionalUsd.toFixed(2)} lev=${sizing.leverage.toFixed(2)}x risk=$${sizing.dollarRisk.toFixed(2)}`,
      );
      bus.emit("trade", {
        orderId:   receipt.orderId,
        coin,
        side:      signal.side,
        size:      receipt.fillSize,
        price:     receipt.fillPrice,
        timestamp: Date.now(),
        success:   true,
        reason:    signal.reason,
        strategy:  bot.config.strategyId,
        botId:     bot.config.id,
      });
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[bot-manager] ${tag} LIVE OPEN failed: ${msg}`);
      bus.emit("error", "bot-manager", e as Error);
    }
  }

  private async executeLiveClose(bot: BotRuntime, reason: string): Promise<void> {
    // If the bot is being deleted, deleteBot() handles the close directly via
    // venue.closePosition(). Allow this to run only when NOT deleted, to avoid
    // double-close races.
    if (bot.deleted) return;
    const pos = bot.position;
    if (!pos) return;
    const coin = bot.config.coin;
    const tag  = `${bot.config.id}/${coin}/${bot.config.timeframe}`;
    try {
      const receipt = await this.venue!.closePosition(coin);
      const pnl =
        pos.side === "long"
          ? (receipt.fillPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - receipt.fillPrice) * pos.size;
      bot.equity          += pnl;
      bot.sessionPnl      += pnl;
      bot.tradeCount++;
      bot.realisedPnl     += pnl;
      bot.realisedTrades++;
      bot.position         = null;
      bot.unrealisedPnl  = 0;
      console.log(
        `[bot-manager] ${tag} LIVE CLOSE` +
        ` oid=${receipt.orderId} fillPx=${receipt.fillPrice.toFixed(4)}` +
        ` PnL=${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} (${reason})`,
      );
      bus.emit("trade", {
        orderId:   receipt.orderId,
        coin,
        side:      pos.side,
        size:      receipt.fillSize,
        price:     receipt.fillPrice,
        timestamp: Date.now(),
        success:   true,
        pnl,
        reason,
        strategy:  bot.config.strategyId,
        botId:     bot.config.id,
      });
    } catch (e) {
      const msg = (e as Error).message;
      // Do NOT clear bot.position or emit a trade — the position may still be open on exchange
      console.error(`[bot-manager] ${tag} LIVE CLOSE failed: ${msg}`);
      bus.emit("error", "bot-manager", e as Error);
    }
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

  // ── Per-bot surgical operations ──────────────────────────────────────────

  async addBot(input: {
    strategyId:      string;
    coin:            string;
    timeframe:       string;
    live?:           boolean;
    startingEquity?: number;
    notional?:       number;
  }): Promise<string> {
    const coin    = input.coin.trim().toUpperCase();
    const live    = input.live ?? false;
    const equity  = Math.max(1, input.startingEquity ?? INITIAL_EQUITY);

    // ── Cross-venue bot ──────────────────────────────────────────────────────
    if (input.strategyId === "cross-venue-funding-basis") {
      if (!this.venue || !this.dydxVenue) {
        throw new Error("Cross-venue strategy requires both HL and dYdX venues to be configured");
      }
      // Validate coin exists on Hyperliquid
      const { universe } = await this.info.meta();
      if (!universe.find((u) => u.name.toUpperCase() === coin)) {
        throw new Error(`"${coin}" is not listed on Hyperliquid perpetuals`);
      }
      const notional = Math.max(1, input.notional ?? INITIAL_EQUITY);
      const id = "cv-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const bc: BotConfig = {
        id, strategyId: "cross-venue-funding-basis", coin,
        timeframe: "—", active: true, live, notional,
      };
      this.botsFile.bots.push(bc);
      this.saveFile();

      const cv = new CrossVenueFundingBasis(this.venue, this.dydxVenue, coin, notional, this.logger, this.cvStateStore, id);
      cv.setExecutionMode(live ? "live" : "paper");
      const runtime: BotRuntime = {
        config: bc, displayName: "Cross-Venue Funding Basis",
        categoryLabel: `HL ↔ dYdX · ${coin}`,
        strategy: null, crossVenue: cv,
        history: [], equity: notional, sessionPnl: 0, tradeCount: 0, realisedPnl: 0, realisedTrades: 0,
        position: null, unrealisedPnl: 0, startedAt: Date.now(),
      };
      this.bots.set(id, runtime);
      void cv.start().catch((e: Error) =>
        console.error(`[bot-manager] Cross-venue start failed ${id}: ${e.message}`),
      );
      console.log(`[bot-manager] Added cross-venue ${id} (${coin} notional=$${notional} mode=${live ? "live" : "paper"})`);
      return id;
    }

    // ── Candle-strategy bot ──────────────────────────────────────────────────
    const timeframe = input.timeframe;
    if (!TF_MS[timeframe]) throw new Error(`Invalid timeframe: ${timeframe}`);
    const entry = getStrategyEntry(input.strategyId);
    if (!entry?.isCandleStrategy || !entry.factory) {
      throw new Error(`Unknown candle strategy: ${input.strategyId}`);
    }

    const { universe } = await this.info.meta();
    const validCoin = universe.find((u) => u.name.toUpperCase() === coin);
    if (!validCoin) {
      const suggestions = universe
        .map((u) => u.name)
        .filter((n) => n.toUpperCase().startsWith(coin.slice(0, 3)))
        .slice(0, 3);
      const hint = suggestions.length
        ? ` Did you mean: ${suggestions.join(", ")}?`
        : " Check the symbol on Hyperliquid.";
      throw new Error(`"${coin}" is not listed on Hyperliquid perpetuals.${hint}`);
    }

    const id = "bot-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const bc: BotConfig = { id, strategyId: input.strategyId, coin, timeframe, active: true, live, startingEquity: equity };
    this.botsFile.bots.push(bc);
    this.saveFile();

    const runtime: BotRuntime = {
      config: bc, displayName: entry.displayName, categoryLabel: entry.categoryLabel,
      strategy: entry.factory(), history: [], equity,
      sessionPnl: 0, tradeCount: 0, realisedPnl: 0, realisedTrades: 0, position: null, unrealisedPnl: 0, startedAt: Date.now(),
    };
    this.bots.set(id, runtime);

    if (this.wsClient) {
      if (!this.coinSubs.has(coin)) {
        if (!this.coinData.has(coin)) {
          this.coinData.set(coin, { hist1m: [], aggBuffers: new Map(), aggHistories: new Map() });
        }
        this.isWarming = true;
        try { await this.warmupCoin(coin); }
        catch (e) {
          const msg = (e as Error).message;
          console.error(`[bot-manager] Warmup failed for ${coin}: ${msg}`);
          this.markCoinError(coin, `Warmup failed: ${msg}`);
        } finally { this.isWarming = false; }
        try { await this.subscribeToCoin(coin); }
        catch (e) {
          const msg = (e as Error).message;
          console.error(`[bot-manager] Subscription failed for ${coin}: ${msg}`);
          this.markCoinError(coin, `Subscription failed: ${msg}`);
        }
      } else {
        await this.warmupSingleBot(runtime);
      }
    }

    console.log(`[bot-manager] Added ${id} (${input.strategyId}/${coin}/${timeframe} equity=$${equity})`);
    return id;
  }

  /** Toggle execution mode for a cross-venue bot (paper ↔ live). */
  setBotMode(id: string, mode: ExecutionMode): void {
    const runtime = this.bots.get(id);
    if (!runtime?.crossVenue) throw new Error(`Bot ${id} is not a cross-venue bot`);
    runtime.crossVenue.setExecutionMode(mode);
    // Persist the live flag to bots.json
    const bc = this.botsFile.bots.find((b) => b.id === id);
    if (bc) {
      bc.live = mode === "live";
      this.saveFile();
    }
    console.log(`[bot-manager] Bot ${id} mode → ${mode}`);
  }

  async pauseBot(id: string): Promise<void> {
    const bc = this.botsFile.bots.find((b) => b.id === id);
    if (!bc || !bc.active) return;
    bc.active = false;
    this.saveFile();
    const runtime = this.bots.get(id);
    if (!runtime) return;
    runtime.config.active = false;
    if (runtime.crossVenue) {
      runtime.crossVenue.pause();
    }
    console.log(`[bot-manager] Paused ${id} (${bc.coin})`);
  }

  async resumeBot(id: string): Promise<void> {
    const bc = this.botsFile.bots.find((b) => b.id === id);
    if (!bc || bc.active) return;
    bc.active = true;
    this.saveFile();
    const runtime = this.bots.get(id);
    if (!runtime) return;
    runtime.config.active = true;

    if (runtime.crossVenue) {
      void runtime.crossVenue.resume().catch((e: Error) =>
        console.error(`[bot-manager] Cross-venue resume failed ${id}: ${e.message}`),
      );
      console.log(`[bot-manager] Resumed ${id} (cross-venue ${bc.coin})`);
      return;
    }

    if (!this.wsClient) return;
    if (!this.coinSubs.has(bc.coin)) {
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
      await this.warmupSingleBot(runtime);
    }
    console.log(`[bot-manager] Resumed ${id} (${bc.coin}/${bc.timeframe})`);
  }

  async deleteBot(id: string): Promise<void> {
    const idx = this.botsFile.bots.findIndex((b) => b.id === id);
    if (idx === -1) return;
    const bc      = this.botsFile.bots[idx];
    const runtime = this.bots.get(id);

    // ── Step 1: Poison the runtime immediately ────────────────────────────────
    // Any in-flight executeLiveSignal / executeLiveOpen / executeLiveClose /
    // reconcileBot that is currently awaiting an API response will see this flag
    // and short-circuit before touching the exchange again.
    if (runtime) runtime.deleted = true;

    // ── Step 2: Tear down the strategy instance ───────────────────────────────
    if (runtime?.strategy) {
      try { (runtime.strategy as { stop?: () => void }).stop?.(); } catch { /* ignore */ }
      runtime.strategy = null;
    }
    if (runtime) runtime.history = []; // release candle history memory

    // ── Step 3: Close any open exchange position for LIVE bots ───────────────
    if (bc.live && runtime && !runtime.crossVenue && this.venue) {
      let exchangePos = null;
      try { exchangePos = await this.venue.getPosition(bc.coin); } catch { /* best-effort */ }
      if (exchangePos) {
        console.log(
          `[bot-manager] deleteBot ${id}: closing open ${bc.coin} position ` +
          `(${exchangePos.side} ${exchangePos.size.toFixed(5)} @ $${exchangePos.entryPrice.toFixed(2)}) before delete`,
        );
        try {
          const receipt = await this.venue.closePosition(bc.coin);
          console.log(`[bot-manager] deleteBot ${id}: position closed — txHash=${receipt.orderId}`);
          this.logger?.logEvent("bot-manager", "info",
            `Position closed on bot delete: ${bc.coin}`,
            { id, coin: bc.coin, receipt },
          );
        } catch (e) {
          console.error(
            `[bot-manager] deleteBot ${id}: close failed — ${(e as Error).message}. ` +
            `Position may remain on exchange; running immediate orphan check.`,
          );
        }
      }
    }

    // ── Step 4: Remove from registry ─────────────────────────────────────────
    this.botsFile.bots.splice(idx, 1);
    this.saveFile();
    this.bots.delete(id);

    // ── Step 5: Cross-venue teardown ─────────────────────────────────────────
    if (runtime?.crossVenue) {
      runtime.crossVenue.stop();
      runtime.crossVenue = undefined;
      console.log(`[bot-manager] Deleted cross-venue bot ${id} (${bc.coin})`);
    } else {
      // ── Step 6: Candle subscription refcount ─────────────────────────────
      const coinStillUsed = this.botsFile.bots.some(
        (b) => b.coin === bc.coin && b.strategyId !== "cross-venue-funding-basis",
      );
      if (!coinStillUsed) {
        const sub = this.coinSubs.get(bc.coin);
        if (sub) {
          try { await sub.unsubscribe(); } catch { /* ignore */ }
          this.coinSubs.delete(bc.coin);
          this.coinData.delete(bc.coin);
          console.log(`[bot-manager] deleteBot ${id}: unsubscribed from ${bc.coin}/1m`);
        }
      } else {
        console.log(`[bot-manager] deleteBot ${id}: kept ${bc.coin}/1m subscription (other bots still use it)`);
      }
      console.log(`[bot-manager] Deleted ${id} (${bc.coin}/${bc.timeframe})`);
    }

    // ── Step 7: Immediate orphan check for this coin ─────────────────────────
    // Don't wait up to 60 s for the background reconcile to notice the position.
    if (bc.live && this.venue) {
      void this.checkOrphanOnDelete(bc.coin);
    }

    // ── Step 8: Debug assertion — bus listener counts ─────────────────────────
    // We don't register any per-bot bus.on() listeners, so counts should be stable.
    // If they grow over time, something is leaking.
    const knownEvents = ["trade", "signal", "signal:approved", "signal:rejected",
                         "candle", "tick", "error", "reconcile:positions"] as const;
    const counts = Object.fromEntries(
      knownEvents.map((ev) => [ev, bus.listenerCount(ev)]),
    );
    console.log(`[bot-manager] deleteBot ${id}: bus listener counts after teardown —`, counts);
    // Warn if any event has an unexpectedly high listener count (suggests a per-bot leak)
    for (const [ev, n] of Object.entries(counts)) {
      if (n > 5) {
        console.warn(`[bot-manager] LEAK SUSPECTED: bus("${ev}") has ${n} listeners after deleting ${id}`);
      }
    }
  }

  /** Check immediately after a bot delete whether the coin now has an orphaned
   *  exchange position, and register it without waiting for the 60-second cycle. */
  private async checkOrphanOnDelete(coin: string): Promise<void> {
    if (!this.venue) return;
    try {
      const pos = await this.venue.getPosition(coin);
      if (!pos) return; // exchange is flat — nothing to orphan

      // Is any remaining live candle-bot still claiming this coin?
      const claimed = [...this.bots.values()].some(
        (b) => b.config.live && b.config.coin === coin && b.position && !b.crossVenue,
      );
      if (!claimed && !this.orphans.has(coin)) {
        console.warn(
          `[reconcile] Orphaned position detected immediately after bot delete: ` +
          `${pos.side} ${pos.size.toFixed(5)} ${coin} @ $${pos.entryPrice.toFixed(2)}`,
        );
        this.orphans.set(coin, { ...pos, detectedAt: Date.now() });
        this.logger?.logEvent("reconcile", "warn",
          `Orphan detected on bot delete: ${coin}`,
          { ...pos, detectedAt: Date.now() },
        );
      }
    } catch (e) {
      console.warn(`[bot-manager] checkOrphanOnDelete failed for ${coin}: ${(e as Error).message}`);
    }
  }

  // ── Reconciliation loop ──────────────────────────────────────────────────

  /**
   * Top-level reconcile cycle: checks every live candle-strategy bot against
   * the real exchange state, then scans for orphaned positions.
   */
  private async runReconcile(): Promise<void> {
    if (!this.venue || this.isWarming) return;
    try {
      // Per-bot reconcile (staggered 200 ms apart to avoid rate-limit bursts)
      let delay = 0;
      for (const bot of this.bots.values()) {
        if (!bot.config.live || bot.crossVenue) continue;
        await new Promise<void>((res) => setTimeout(res, delay));
        delay += 200;
        await this.reconcileBot(bot);
      }
      // Orphan scan uses one clearinghouseState call for the full position list
      await this.detectOrphans();
    } catch (e) {
      console.error("[reconcile] Cycle failed:", (e as Error).message);
    }
  }

  private async reconcileBot(bot: BotRuntime): Promise<void> {
    if (bot.deleted) return; // bot was deleted between scheduling and execution
    let exchangePos: import("./venue.js").VenuePosition | null = null;
    try {
      exchangePos = await this.venue!.getPosition(bot.config.coin);
    } catch (e) {
      // If the venue call fails don't wipe the bot state — just log
      console.warn(`[reconcile] ${bot.config.id}: could not fetch exchange position: ${(e as Error).message}`);
      return;
    }

    if (bot.deleted) return; // deleted while awaiting getPosition

    const botPos = bot.position;

    // Case A: exchange FLAT, bot thinks OPEN
    if (!exchangePos && botPos) {
      const desc = `${botPos.side} ${botPos.size.toFixed(5)} @ $${botPos.entryPrice.toFixed(2)}`;
      console.warn(
        `[reconcile] ${bot.config.id}/${bot.config.coin}: expected ${desc} ` +
        `but exchange is FLAT — clearing bot state (exchange is source of truth)`,
      );
      bot.position           = null;
      bot.unrealisedPnl      = 0;
      bot.hadRecentMismatch  = true;
      bot.lastReconcileEvent = `Cleared stale position (bot had ${desc}, exchange flat)`;
      this.logger?.logEvent("reconcile", "warn",
        `Position cleared: ${bot.config.coin} — bot had ${desc}, exchange flat`,
        { id: bot.config.id, botPosition: botPos },
      );
      return;
    }

    // Case B: exchange OPEN, bot thinks FLAT — adopt it
    if (exchangePos && !botPos) {
      console.warn(
        `[reconcile] ${bot.config.id}/${bot.config.coin}: expected FLAT but exchange shows ` +
        `${exchangePos.side} ${exchangePos.size.toFixed(5)} @ $${exchangePos.entryPrice.toFixed(2)} — adopting`,
      );
      bot.position = {
        side:          exchangePos.side,
        entryPrice:    exchangePos.entryPrice,
        size:          exchangePos.size,
        entryTime:     Date.now(),
        unrealisedPnl: exchangePos.unrealisedPnl,
      };
      bot.unrealisedPnl      = exchangePos.unrealisedPnl;
      bot.hadRecentMismatch  = true;
      bot.lastReconcileEvent =
        `Adopted from exchange: ${exchangePos.side} ${exchangePos.size.toFixed(5)} ` +
        `@ $${exchangePos.entryPrice.toFixed(2)}`;
      // Write an "adopted" trade event so it appears in the Trades log
      bus.emit("trade", {
        orderId:   `adopted-${Date.now()}`,
        coin:      bot.config.coin,
        side:      exchangePos.side,
        size:      exchangePos.size,
        price:     exchangePos.entryPrice,
        timestamp: Date.now(),
        success:   true,
        reason:    "adopted_from_exchange",
        strategy:  bot.config.strategyId,
        botId:     bot.config.id,
      });
      this.logger?.logEvent("reconcile", "warn",
        `Position adopted: ${bot.config.coin} — exchange shows ${exchangePos.side} ${exchangePos.size.toFixed(5)} @ $${exchangePos.entryPrice.toFixed(2)}`,
        { id: bot.config.id, exchangePosition: exchangePos },
      );
      return;
    }

    // Case C: both have a position — check for meaningful drift
    if (exchangePos && botPos) {
      const sideDiff  = exchangePos.side !== botPos.side;
      const sizeDelta = botPos.size > 0 ? Math.abs(exchangePos.size - botPos.size) / botPos.size : 1;
      if (sideDiff || sizeDelta > 0.01) {
        const was = `${botPos.side} ${botPos.size.toFixed(5)} @ $${botPos.entryPrice.toFixed(2)}`;
        const now = `${exchangePos.side} ${exchangePos.size.toFixed(5)} @ $${exchangePos.entryPrice.toFixed(2)}`;
        console.warn(
          `[reconcile] ${bot.config.id}/${bot.config.coin}: position drift — ` +
          `bot: ${was}, exchange: ${now} — adopting exchange`,
        );
        bot.position = {
          side:          exchangePos.side,
          entryPrice:    exchangePos.entryPrice,
          size:          exchangePos.size,
          entryTime:     botPos.entryTime, // preserve original entry time
          unrealisedPnl: exchangePos.unrealisedPnl,
        };
        bot.hadRecentMismatch  = true;
        bot.lastReconcileEvent = `Drift corrected: was ${was}, now ${now}`;
        this.logger?.logEvent("reconcile", "warn",
          `Position drift corrected: ${bot.config.coin}`,
          { id: bot.config.id, was: botPos, now: exchangePos },
        );
      } else {
        // In sync — live-update the mark-to-market P&L
        if (bot.position) bot.position.unrealisedPnl = exchangePos.unrealisedPnl;
        bot.unrealisedPnl          = exchangePos.unrealisedPnl;
        // Clear stale mismatch flag after a clean check
        if (bot.hadRecentMismatch) {
          bot.hadRecentMismatch = false;
        }
      }
    }
  }

  private async detectOrphans(): Promise<void> {
    if (!this.venue) return;
    let allPos: import("./venue.js").VenuePosition[];
    try {
      allPos = await this.venue.getAllPositions();
    } catch (e) {
      console.warn("[reconcile] detectOrphans: could not fetch all positions:", (e as Error).message);
      return;
    }

    // Coins claimed by a currently-live candle-strategy bot with an open position
    const claimed = new Set<string>();
    for (const bot of this.bots.values()) {
      if (bot.config.live && bot.position && !bot.crossVenue) {
        claimed.add(bot.config.coin);
      }
    }

    // Register newly discovered orphans; refresh P&L for existing ones.
    // Refreshing every cycle is critical for the emergency-close threshold check below.
    for (const pos of allPos) {
      if (!claimed.has(pos.coin)) {
        const existing = this.orphans.get(pos.coin);
        if (!existing) {
          console.warn(
            `[reconcile] Orphaned position detected: ${pos.side} ${pos.size.toFixed(5)} ` +
            `${pos.coin} @ $${pos.entryPrice.toFixed(2)} — no bot owns this`,
          );
          this.orphans.set(pos.coin, { ...pos, detectedAt: Date.now() });
          this.logger?.logEvent("reconcile", "warn",
            `Orphan detected: ${pos.coin}`,
            { ...pos, detectedAt: Date.now() },
          );
        } else {
          // Refresh mark price and P&L from the exchange so the emergency-close
          // check always sees current numbers, not stale detection-time values.
          this.orphans.set(pos.coin, { ...pos, detectedAt: existing.detectedAt });
        }
      }
    }

    // Evict orphans that are no longer on the exchange
    const exchangeCoins = new Set(allPos.map((p) => p.coin));
    for (const [coin] of this.orphans) {
      if (!exchangeCoins.has(coin)) this.orphans.delete(coin);
    }

    // ── Orphan close decisions (improvement 2) ─────────────────────────────
    // Iterate over a snapshot so we can delete from this.orphans safely.
    const emergencyLossPct = config.risk.orphanEmergencyCloseLossPct ?? 5;
    for (const [coin, orphan] of [...this.orphans]) {
      const notional = orphan.size * orphan.entryPrice;
      if (notional > 0) {
        // Positive lossPct = losing money (unrealisedPnl is negative when losing)
        const lossPct = -(orphan.unrealisedPnl / notional) * 100;
        if (lossPct >= emergencyLossPct) {
          // Catastrophic move — close immediately, don't wait for the 24-hour grace period
          console.warn(
            `[reconcile] Orphan emergency close — ` +
            `${orphan.side} ${orphan.size.toFixed(5)} ${coin} ` +
            `down ${lossPct.toFixed(1)}% (notional $${notional.toFixed(0)})`,
          );
          try {
            const receipt = await this.venue!.closePosition(coin);
            this.orphans.delete(coin);
            console.log(`[reconcile] Orphan emergency-closed ${coin} — txHash=${receipt.orderId}`);
            this.logger?.logEvent("reconcile", "warn",
              `Orphan emergency closed: ${coin}`,
              { coin, receipt, lossPct, notional, trigger: "emergency_loss" },
            );
          } catch (e) {
            console.error(`[reconcile] Orphan emergency close failed for ${coin}:`, (e as Error).message);
          }
          continue; // don't also try the 24-hour auto-close for this coin
        }
      }

      // 24-hour grace-period auto-close
      if (Date.now() - orphan.detectedAt >= ORPHAN_AUTO_CLOSE_MS) {
        console.warn(`[reconcile] Auto-closing orphan ${coin} (older than 24 h)`);
        try {
          const receipt = await this.venue!.closePosition(coin);
          this.orphans.delete(coin);
          console.log(`[reconcile] Auto-closed orphan ${coin} — txHash=${receipt.orderId}`);
          this.logger?.logEvent("reconcile", "info",
            `Orphan auto-closed: ${coin}`,
            { coin, receipt, trigger: "auto_24h" },
          );
        } catch (e) {
          console.error(`[reconcile] Auto-close of orphan ${coin} failed:`, (e as Error).message);
        }
      }
    }

    // ── Risk-map sync (improvement 3) ──────────────────────────────────────
    // Emit the full exchange position list so RiskManager can rebuild openRisks
    // from ground truth, correcting any drift from missed trade events.
    bus.emit("reconcile:positions", allPos.map((p) => ({
      coin:  p.coin,
      size:  p.size,
      price: p.markPrice > 0 ? p.markPrice : p.entryPrice,
    })));
  }

  private async warmupSingleBot(bot: BotRuntime): Promise<void> {
    if (bot.crossVenue) return; // cross-venue bots don't need candle warmup
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

}
