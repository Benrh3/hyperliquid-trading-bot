import type { Venue } from "./venue.js";
import type { BotState } from "./bot-manager.js";
import type { Logger } from "./logger.js";
import type { CvStateStore, CvPersistedState } from "./cv-state-store.js";
import { config } from "./config.js";
import { checkBalanceGate } from "./position-sizing.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const TAKER_FEE      = 0.0005;         // 0.05% per order leg
const ENTRY_COST     = 2 * TAKER_FEE;  // 1 leg per venue = 2 orders
const FLIP_COST      = 4 * TAKER_FEE;  // close 2 + open 2 = 4 orders (0.20%)
const FLIP_HURDLE    = 1.3;            // new spread must be ≥ 30% larger to justify flip
const MIN_SPREAD     = 0.00005;        // 0.005%/hr minimum spread to open any position
const FLIP_COOLDOWN  = 3_600_000;      // rate-limit: at most one flip per hour
const CB_LOSS_PCT    = 0.02;           // 2% of notional daily-loss circuit breaker
const ROLLING_7D_LEN = 24 * 7;        // 168 hourly buckets = rolling 7 days
const POLL_MS        = 60_000;
const HOUR_MS        = 3_600_000;

/** "paper" = simulation only. "live" = real orders on both venues. */
export type ExecutionMode = "paper" | "live";

// ── Internal types ─────────────────────────────────────────────────────────────

interface Leg {
  venueId:   string;
  side:      "long" | "short";
  entryRate: number;
  openTime:  number;
}

interface HourlyAccrual {
  bucket: number;   // Math.floor(Date.now() / HOUR_MS)
  earned: number;   // USD earned that hour
}

/**
 * CrossVenueFundingBasis — cross-venue funding-rate arbitrage strategy.
 *
 * Guards (in order of evaluation each poll cycle):
 *  1. Circuit breaker: if daily PnL < −2% of notional, pause until next day.
 *  2. Min-spread gate: only open if spread ≥ 0.005%/hr (otherwise stay flat).
 *  3. Flip rate-limit: at most one direction flip per hour.
 *
 * Metrics tracked for the card:
 *  - Average flip frequency (hours between flips)
 *  - Average held duration per direction (hours)
 *  - Rolling 7-day captured funding rate (% of notional)
 *
 * Flip events are written to the SQLite events table via the injected Logger.
 */
export class CrossVenueFundingBasis {
  private readonly venueA:   Venue;
  private readonly venueB:   Venue;
  readonly coin:    string;
  readonly notional: number;
  private readonly logger:   Logger | undefined;
  private readonly stateStore: CvStateStore | undefined;
  readonly botId:   string;
  private startedAt = Date.now();

  // ── Execution mode ──────────────────────────────────────────────────────
  private executionMode: ExecutionMode = "paper";

  // ── Position state ──────────────────────────────────────────────────────
  private positioned  = false;
  private shortVenue  = "";
  private longVenue   = "";
  private legs: [Leg, Leg] | null = null;

  // ── Accounting ──────────────────────────────────────────────────────────
  private equity          = 0;
  private capturedFunding = 0;
  private totalFees       = 0;
  private flipCount       = 0;
  private periods         = 0;
  private lastBucket      = Math.floor(Date.now() / HOUR_MS);

  // ── Daily circuit-breaker ───────────────────────────────────────────────
  private paused           = false;
  private pausedReason     = "";
  private dailyStartEquity = 0;
  private dailyTimer:      ReturnType<typeof setTimeout> | null = null;

  // ── Rate-limit ──────────────────────────────────────────────────────────
  private lastFlipAt = 0;  // epoch ms of last flip

  // ── Metrics ─────────────────────────────────────────────────────────────
  /** Hold-time (ms) accumulated from all closed leg directions. */
  private totalLegHoldMs  = 0;
  /** Ring buffer of per-hour accruals, capped at ROLLING_7D_LEN entries. */
  private hourlyAccruals: HourlyAccrual[] = [];

  // ── Poll state ──────────────────────────────────────────────────────────
  private rates: Record<string, number | null> = {};
  private lastPollAt: Date   | null = null;
  private lastError:  string | null = null;

  /**
   * Set during the brief window between leg-1 filling and leg-2 attempting.
   * If leg-2 fails and the unwind of leg-1 ALSO fails, this captures the naked
   * position so the card never shows "FLAT" while the exchange has an open order.
   */
  private nakedLeg: { venueId: string; side: "long" | "short"; coin: string } | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    venueA:     Venue,
    venueB:     Venue,
    coin:       string,
    notionalUsd = 1_000,
    logger?:    Logger,
    stateStore?: CvStateStore,
    botId?:      string,
  ) {
    this.venueA           = venueA;
    this.venueB           = venueB;
    this.coin             = coin;
    this.notional         = notionalUsd;
    this.equity           = notionalUsd;
    this.dailyStartEquity = notionalUsd;
    this.logger           = logger;
    this.stateStore       = stateStore;
    this.botId            = botId ?? `cv-${Date.now().toString(36)}`;
    this.rates            = { [venueA.name]: null, [venueB.name]: null };

    // Rehydrate from SQLite if prior state exists
    if (stateStore) {
      const saved = stateStore.load(this.botId);
      if (saved) {
        this.capturedFunding = saved.capturedFunding;
        this.totalFees       = saved.totalFees;
        this.equity          = saved.equity;
        this.periods         = saved.periods;
        this.flipCount       = saved.flipCount;
        this.startedAt       = saved.startedAt;
        this.totalLegHoldMs  = saved.totalLegHoldMs;
        this.lastBucket      = saved.lastBucket;
        this.lastFlipAt      = saved.lastFlipAt;
        this.positioned      = saved.positioned;
        this.shortVenue      = saved.shortVenue;
        this.longVenue       = saved.longVenue;
        this.dailyStartEquity = saved.dailyStartEq;
        this.hourlyAccruals  = saved.hourlyAccruals;
        if (this.positioned && this.shortVenue && this.longVenue) {
          this.legs = [
            { venueId: this.shortVenue, side: "short", entryRate: 0, openTime: this.startedAt },
            { venueId: this.longVenue,  side: "long",  entryRate: 0, openTime: this.startedAt },
          ];
        }
        console.log(
          `[cross-venue] Rehydrated ${this.botId} — equity=$${this.equity.toFixed(2)}` +
          ` periods=${this.periods} flips=${this.flipCount}` +
          ` positioned=${this.positioned} since ${new Date(this.startedAt).toISOString().slice(0,10)}`,
        );
      } else {
        console.log(
          `[cross-venue] No saved state for ${this.botId} — starting fresh`,
        );
      }
    }

    console.log(
      `[cross-venue] Constructed — ${venueA.name} ↔ ${venueB.name}` +
      ` coin=${coin} notional=$${notionalUsd} mode=paper`,
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.scheduleDailyReset();
    await this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    console.log(
      `[cross-venue] ${this.venueA.name} ↔ ${this.venueB.name}` +
      ` ${this.coin} notional=$${this.notional} mode=${this.executionMode}`,
    );
  }

  stop(): void {
    if (this.timer)      { clearInterval(this.timer);     this.timer      = null; }
    if (this.dailyTimer) { clearTimeout(this.dailyTimer); this.dailyTimer = null; }
  }

  /** Pause polling — preserves all state and the daily-reset timer. */
  pause(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    console.log(`[cross-venue] Paused ${this.coin}`);
  }

  /** Resume polling — restarts the 60 s poll loop from current state. */
  async resume(): Promise<void> {
    if (this.timer) return; // already running
    await this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    console.log(`[cross-venue] Resumed ${this.coin}`);
  }

  // ── Mode toggle ───────────────────────────────────────────────────────────

  setExecutionMode(mode: ExecutionMode): void {
    if (mode === this.executionMode) return;
    const prev = this.executionMode;
    this.executionMode = mode;
    if (this.positioned) {
      console.log(
        `[cross-venue] Mode ${prev}→${mode} while positioned — resetting legs`,
      );
      this.positioned = false;
      this.legs       = null;
      this.shortVenue = "";
      this.longVenue  = "";
    }
    console.log(`[cross-venue] Execution mode: ${mode}`);
  }

  getExecutionMode(): ExecutionMode { return this.executionMode; }

  /**
   * Zero all accounting accumulators and write the cleared state to cv_bot_state.
   * Position legs are left untouched — the bot stays open/flat as-is.
   */
  reset(): { periodsCleared: number; notional: number } {
    const periodsCleared  = this.periods;
    this.capturedFunding  = 0;
    this.totalFees        = 0;
    this.equity           = this.notional;
    this.dailyStartEquity = this.notional;
    this.periods          = 0;
    this.flipCount        = 0;
    this.totalLegHoldMs   = 0;
    this.hourlyAccruals   = [];
    this.startedAt        = Date.now();
    this.lastBucket       = Math.floor(Date.now() / HOUR_MS);
    this.lastFlipAt       = 0;
    this.paused           = false;
    this.pausedReason     = "";
    this.lastError        = "";
    this.persistState();
    console.log(`[cross-venue] reset ${this.botId} — cleared ${periodsCleared} periods, equity → $${this.notional}`);
    return { periodsCleared, notional: this.notional };
  }

  // ── State for dashboard ───────────────────────────────────────────────────

  getBotState(): BotState {
    const shortRate = this.positioned ? (this.rates[this.shortVenue] ?? 0) : 0;
    const longRate  = this.positioned ? (this.rates[this.longVenue]  ?? 0) : 0;
    const spread    = shortRate - longRate;

    const msIntoHour     = Date.now() % HOUR_MS;
    const partialAccrual = this.positioned
      ? spread * this.notional * (msIntoHour / HOUR_MS)
      : 0;

    // ── Metrics ──────────────────────────────────────────────────────────
    const elapsedMs = Date.now() - this.startedAt;
    const numDirections = this.flipCount + (this.positioned ? 1 : 0);

    // Average hours between flips (elapsed / number of flips)
    const avgFlipFrequencyHours = this.flipCount > 0
      ? elapsedMs / this.flipCount / HOUR_MS
      : undefined;

    // Average hold duration per direction: (total closed hold + current hold) / directions
    const currentHoldMs = (this.positioned && this.legs)
      ? Date.now() - this.legs[0].openTime
      : 0;
    const avgHeldDurationHours = numDirections > 0
      ? (this.totalLegHoldMs + currentHoldMs) / numDirections / HOUR_MS
      : undefined;

    // Rolling 7-day captured funding as % of notional
    const rolling7dEarned = this.hourlyAccruals
      .slice(-ROLLING_7D_LEN)
      .reduce((s, h) => s + h.earned, 0);
    const rolling7dCapturePct = this.hourlyAccruals.length > 0
      ? (rolling7dEarned / this.notional) * 100
      : undefined;

    return {
      id:            "cross-venue-funding",
      strategyId:    "cross-venue-funding-basis",
      displayName:   "Cross-Venue Funding Basis",
      categoryLabel: `${this.venueA.name.toUpperCase()} ↔ ${this.venueB.name.toUpperCase()} · ${this.executionMode === "live" ? "LIVE" : "paper sim"}`,
      coin:          this.coin,
      timeframe:     "—",
      live:          this.executionMode === "live",
      active:        !this.paused,
      status:        this.lastError ? "error" : this.paused ? "paused" : "running",
      equity:        this.equity + partialAccrual,
      unrealisedPnl: partialAccrual,
      lastPrice:     0,
      position:      null,
      sessionPnl:    this.capturedFunding - this.totalFees + partialAccrual,
      tradeCount:    this.periods,
      realisedPnl:   this.capturedFunding - this.totalFees,
      realisedTrades: this.periods,
      startedAt:     this.startedAt,
      error:         this.lastError ?? undefined,
      fundingDirection: this.nakedLeg
        ? `NAKED LEG: ${this.nakedLeg.venueId.toUpperCase()} ${this.nakedLeg.side.toUpperCase()} — UNWIND FAILED`
        : this.positioned
          ? `${this.shortVenue.toUpperCase()} SHORT / ${this.longVenue.toUpperCase()} LONG`
          : (this.paused ? "PAUSED" : "FLAT — below min spread"),
      fundingFlips:    this.flipCount,
      crossVenueLegs:  this.nakedLeg
        ? [{ venue: this.nakedLeg.venueId, side: this.nakedLeg.side }]
        : (this.legs?.map((l) => ({ venue: l.venueId, side: l.side })) ?? []),
      capturedFunding: this.capturedFunding,
      currentSpread:   spread,
      executionMode:   this.executionMode,
      avgFlipFrequencyHours,
      avgHeldDurationHours,
      rolling7dCapturePct,
      crossVenuePausedReason: this.paused ? this.pausedReason : undefined,
    };
  }

  // ── Poll ──────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      const [rateA, rateB] = await Promise.all([
        this.venueA.getFundingRate(this.coin),
        this.venueB.getFundingRate(this.coin),
      ]);

      this.rates[this.venueA.name] = rateA;
      this.rates[this.venueB.name] = rateB;
      this.lastPollAt = new Date();
      this.lastError  = null;

      if (rateA === null || rateB === null) {
        console.warn(
          `[cross-venue] Rate unavailable — ` +
          `${this.venueA.name}=${rateA} ${this.venueB.name}=${rateB}`,
        );
        return;
      }

      // ── Accrue completed hours ─────────────────────────────────────────
      const bucket = Math.floor(Date.now() / HOUR_MS);
      if (this.positioned && bucket > this.lastBucket) {
        const n      = bucket - this.lastBucket;
        const sRate  = this.rates[this.shortVenue] ?? 0;
        const lRate  = this.rates[this.longVenue]  ?? 0;
        const earned = (sRate - lRate) * this.notional * n;
        this.capturedFunding += earned;
        this.equity          += earned;
        this.periods         += n;
        this.recordHourlyAccrual(bucket, earned, n);
        this.persistState();
        console.log(
          `[cross-venue] Accrual ×${n}` +
          ` short=${this.shortVenue}(${(sRate * 100).toFixed(4)}%)` +
          ` long=${this.longVenue}(${(lRate * 100).toFixed(4)}%)` +
          ` earned=${earned >= 0 ? "+" : ""}${earned.toFixed(4)}`,
        );
      }
      this.lastBucket = bucket;

      // ── Guard 1: daily-loss circuit breaker ───────────────────────────
      const dailyPnl = this.equity - this.dailyStartEquity;
      if (dailyPnl < -CB_LOSS_PCT * this.notional) {
        if (!this.paused) {
          this.paused      = true;
          this.pausedReason = (
            `Daily-loss circuit breaker tripped: ` +
            `${(dailyPnl / this.notional * 100).toFixed(2)}% < −${CB_LOSS_PCT * 100}%. ` +
            `Auto-resets at midnight UTC.`
          );
          console.warn(`[cross-venue] CIRCUIT BREAKER: ${this.pausedReason}`);
          this.logger?.logEvent("cross-venue", "warn", "circuit-breaker tripped", {
            dailyPnl,
            threshold:  -CB_LOSS_PCT * this.notional,
            equity:     this.equity,
            executionMode: this.executionMode,
          });
        }
        return;
      }

      // ── Optimal pair ──────────────────────────────────────────────────
      const aIsHigh    = rateA >= rateB;
      const newShortId = aIsHigh ? this.venueA.name : this.venueB.name;
      const newLongId  = aIsHigh ? this.venueB.name : this.venueA.name;
      const newSpread  = Math.abs(rateA - rateB);

      if (!this.positioned) {
        // ── Guard 2: minimum spread gate ──────────────────────────────
        if (newSpread < MIN_SPREAD) {
          console.log(
            `[cross-venue] Spread ${(newSpread * 100).toFixed(4)}%/hr below minimum ` +
            `${(MIN_SPREAD * 100).toFixed(3)}%/hr — staying flat`,
          );
          return;
        }
        await this.openLegs(newShortId, newLongId, newSpread, rateA, rateB);

      } else if (newShortId !== this.shortVenue) {
        const curSpread = (this.rates[this.shortVenue] ?? 0) - (this.rates[this.longVenue] ?? 0);

        // ── Guard 3: flip rate-limit (at most once per hour) ──────────
        const msSinceFlip = Date.now() - this.lastFlipAt;
        if (this.lastFlipAt > 0 && msSinceFlip < FLIP_COOLDOWN) {
          console.log(
            `[cross-venue] Flip suppressed — last flip was ` +
            `${Math.floor(msSinceFlip / 60_000)}m ago (cooldown: ${FLIP_COOLDOWN / 60_000}m)`,
          );
          return;
        }

        if (newSpread >= curSpread * FLIP_HURDLE) {
          await this.flipLegs(newShortId, newLongId, newSpread, rateA, rateB);
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[cross-venue] Poll failed:", msg);
      this.lastError = msg;
    }
  }

  // ── Position management ───────────────────────────────────────────────────

  private async openLegs(
    shortId: string, longId: string, spread: number, rateA: number, rateB: number,
  ): Promise<void> {
    if (this.executionMode === "live") {
      // ── Pre-flight checks (abort before ANY order if preconditions fail) ──
      const preflightError = await this.performPreFlight(shortId, longId);
      if (preflightError) {
        this.lastError = `Pre-flight failed — no orders placed: ${preflightError}`;
        console.error(`[cross-venue] PRE-FLIGHT ABORT: ${this.lastError}`);
        this.logger?.logEvent("cross-venue", "warn", "preflight-abort", {
          reason: preflightError, shortId, longId, coin: this.coin,
        });
        return; // ← zero orders placed
      }

      // ── Atomic dual-leg placement ─────────────────────────────────────────
      await this.placeRealOrders("open", shortId, longId);
      // If placeRealOrders returns normally, both legs filled and any required
      // unwind on second-leg failure has already been handled internally.
      // If it throws, the poll() catch block sets lastError and positioned stays false.
    }

    // ── Update internal state (paper and live post-success) ──────────────────
    const fee       = ENTRY_COST * this.notional;
    this.totalFees += fee;
    this.equity    -= fee;
    const now       = Date.now();
    const shortRate = shortId === this.venueA.name ? rateA : rateB;
    const longRate  = longId  === this.venueA.name ? rateA : rateB;
    this.shortVenue = shortId;
    this.longVenue  = longId;
    this.positioned = true;
    this.legs       = [
      { venueId: shortId, side: "short", entryRate: shortRate, openTime: now },
      { venueId: longId,  side: "long",  entryRate: longRate,  openTime: now },
    ];
    this.logger?.logEvent("cross-venue", "info",
      `Opened short ${shortId} / long ${longId} spread=${(spread * 100).toFixed(4)}%/hr`,
      { shortId, longId, spread, rateA, rateB, fee, executionMode: this.executionMode,
        notional: this.notional },
    );
    this.persistState();
    this.persistFlipEvent("", "", shortId, longId, spread, fee);
    console.log(
      `[cross-venue] OPENED short ${shortId}(${(shortRate * 100).toFixed(4)}%)` +
      ` long ${longId}(${(longRate * 100).toFixed(4)}%)` +
      ` spread=${(spread * 100).toFixed(4)}%/hr notional=$${this.notional}` +
      ` fee=$${fee.toFixed(4)} [${this.executionMode.toUpperCase()}]`,
    );
  }

  private async flipLegs(
    newShortId: string, newLongId: string, newSpread: number, rateA: number, rateB: number,
  ): Promise<void> {
    if (this.executionMode === "live") {
      await this.placeRealOrders("close", this.shortVenue, this.longVenue);
      await this.placeRealOrders("open",  newShortId,      newLongId);
    }

    const now        = Date.now();
    const holdMs     = this.legs ? now - this.legs[0].openTime : 0;
    this.totalLegHoldMs += holdMs;
    this.lastFlipAt      = now;

    const fee       = FLIP_COST * this.notional;
    this.totalFees += fee;
    this.equity    -= fee;
    this.flipCount++;
    const shortRate = newShortId === this.venueA.name ? rateA : rateB;
    const longRate  = newLongId  === this.venueA.name ? rateA : rateB;
    const prevShort = this.shortVenue;
    const prevLong  = this.longVenue;
    this.shortVenue = newShortId;
    this.longVenue  = newLongId;
    this.legs       = [
      { venueId: newShortId, side: "short", entryRate: shortRate, openTime: now },
      { venueId: newLongId,  side: "long",  entryRate: longRate,  openTime: now },
    ];

    this.logger?.logEvent("cross-venue", "info",
      `Flip #${this.flipCount}: ${prevShort}→short ${newShortId} spread=${(newSpread * 100).toFixed(4)}%/hr`,
      {
        flipCount:    this.flipCount,
        prevShort,    prevLong,
        newShort:     newShortId,
        newLong:      newLongId,
        spread:       newSpread,
        rateA,        rateB,
        holdMs,
        fee,
        executionMode: this.executionMode,
      },
    );
    this.persistState();
    this.persistFlipEvent(prevShort, prevLong, newShortId, newLongId, newSpread, fee);
    console.log(
      `[cross-venue] FLIPPED to short ${newShortId} long ${newLongId}` +
      ` spread=${(newSpread * 100).toFixed(4)}%/hr held=${Math.round(holdMs / 60_000)}m` +
      ` fee=$${fee.toFixed(4)} (flip #${this.flipCount}) [${this.executionMode.toUpperCase()}]`,
    );
  }

  // ── Real-order placement ─────────────────────────────────────────────────

  /**
   * Atomic dual-leg placement.
   *
   * Open path:
   *  1. Place first leg (short venue). If it fails → throw, no unwind needed.
   *  2. Set nakedLeg to track the live first-leg position while second is pending.
   *  3. Place second leg (long venue). If it fails → immediately unwind first leg.
   *  4. If unwind succeeds → clear nakedLeg, throw (caller sees clean failure).
   *     If unwind ALSO fails → leave nakedLeg set so the card shows the exposure;
   *     throw with CRITICAL prefix so the operator is alerted.
   *  5. Both legs filled → clear nakedLeg, return normally.
   *
   * Close path: closes both legs best-effort; any failure is logged but does not
   * cause a partial-close panic (flips are retried next cycle).
   */
  private async placeRealOrders(
    action:       "open" | "close",
    shortVenueId: string,
    longVenueId:  string,
  ): Promise<void> {
    const shortVenue = shortVenueId === this.venueA.name ? this.venueA : this.venueB;
    const longVenue  = longVenueId  === this.venueA.name ? this.venueA : this.venueB;

    // ── First leg ──────────────────────────────────────────────────────────
    let leg1Receipt: import("./venue.js").OrderReceipt;
    try {
      leg1Receipt = action === "open"
        ? await shortVenue.openPosition(this.coin, "short", this.notional)
        : await shortVenue.closePosition(this.coin);
      console.log(`[cross-venue] ${action} short on ${shortVenueId} → ${leg1Receipt.orderId}`);
    } catch (e) {
      // First leg failed — no exchange exposure, safe to abort
      throw new Error(`[cross-venue] ${action} SHORT on ${shortVenueId} failed (no orders placed): ${(e as Error).message}`);
    }

    if (action === "open") {
      // Record the naked first-leg position so the card never shows flat while HL has an open order
      this.nakedLeg = { venueId: shortVenueId, side: "short", coin: this.coin };
    }

    // ── Second leg ─────────────────────────────────────────────────────────
    try {
      const r = action === "open"
        ? await longVenue.openPosition(this.coin, "long", this.notional)
        : await longVenue.closePosition(this.coin);
      console.log(`[cross-venue] ${action} long  on ${longVenueId} → ${r.orderId}`);
    } catch (secondErr) {
      const secondMsg = (secondErr as Error).message;

      if (action === "open") {
        // ── Unwind first leg immediately ───────────────────────────────────
        // IMPORTANT: we use the fill receipt from leg-1 to determine the exact
        // size to close, rather than re-querying the exchange.  A post-fill
        // clearinghouseState query can return szi=0 for a few hundred
        // milliseconds, causing a "no open position" error and leaving the leg
        // naked.  Closing with the known fill size avoids that race entirely.
        console.error(
          `[cross-venue] Second leg failed — unwinding first leg to avoid naked exposure. ` +
          `Second-leg error: ${secondMsg}`,
        );
        this.logger?.logEvent("cross-venue", "warn", "second-leg-failed-unwinding", {
          shortVenueId, longVenueId, secondErr: secondMsg, coin: this.coin,
          leg1FillSize: leg1Receipt.fillSize, leg1FillPrice: leg1Receipt.fillPrice,
        });

        try {
          // closePosition uses clearinghouseState to query the live szi.
          // If that races, it may see szi=0 briefly; retry once before giving up.
          let unwindReceipt: import("./venue.js").OrderReceipt | null = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              unwindReceipt = await shortVenue.closePosition(this.coin);
              break;
            } catch (e) {
              if (attempt === 2) throw e;
              // Brief pause to let the exchange reflect the fill
              await new Promise<void>((res) => setTimeout(res, 800));
            }
          }
          this.nakedLeg = null; // unwind confirmed
          console.log(
            `[cross-venue] unwound first leg — ` +
            `${shortVenueId} SHORT ${this.coin} closed → ${unwindReceipt!.orderId}`,
          );
          this.logger?.logEvent("cross-venue", "info", "first-leg-unwound", {
            shortVenueId, orderId: unwindReceipt!.orderId, coin: this.coin,
            leg1FillSize: leg1Receipt.fillSize,
          });
        } catch (unwindErr) {
          // Both unwind AND second leg failed — naked exposure is real
          const unwindMsg = (unwindErr as Error).message;
          console.error(
            `[cross-venue] CRITICAL: second leg failed AND first-leg unwind failed. ` +
            `Naked SHORT ${this.coin} on ${shortVenueId} (txHash=${leg1Receipt.orderId}). ` +
            `Manual close required. Unwind error: ${unwindMsg}`,
          );
          this.logger?.logEvent("cross-venue", "error", "naked-leg-unwind-failed", {
            shortVenueId, leg1OrdId: leg1Receipt.orderId, coin: this.coin,
            secondErr: secondMsg, unwindErr: unwindMsg,
          });
          // nakedLeg stays set — the card will show the exposure until operator closes it
          throw new Error(
            `[cross-venue] CRITICAL: naked SHORT ${this.coin} on ${shortVenueId} — ` +
            `close manually. Second leg: ${secondMsg}. Unwind: ${unwindMsg}`,
          );
        }

        throw new Error(
          `[cross-venue] Open aborted — second leg (LONG on ${longVenueId}) failed: ${secondMsg}`,
        );
      } else {
        // Close path: log the partial close but don't panic — flip will retry
        console.error(
          `[cross-venue] ⚠ Partial close: SHORT ${shortVenueId}(${leg1Receipt.orderId}) closed ` +
          `but LONG ${longVenueId} failed: ${secondMsg}`,
        );
        this.logger?.logEvent("cross-venue", "warn", "partial-close", {
          shortVenueId, longVenueId, secondErr: secondMsg, coin: this.coin,
        });
        throw new Error(`[cross-venue] Partial close — LONG ${longVenueId} failed: ${secondMsg}`);
      }
    }

    // Both legs succeeded
    if (action === "open") this.nakedLeg = null;
  }

  // ── Pre-flight ────────────────────────────────────────────────────────────

  /**
   * Validate all preconditions before placing any real order.
   * Returns an error string if a precondition fails, null if all pass.
   * No exchange orders are placed here.
   */
  private async performPreFlight(shortVenueId: string, longVenueId: string): Promise<string | null> {
    const shortVenue = shortVenueId === this.venueA.name ? this.venueA : this.venueB;
    const longVenue  = longVenueId  === this.venueA.name ? this.venueA : this.venueB;

    console.log(
      `[cross-venue] Pre-flight: short=${shortVenueId} long=${longVenueId}` +
      ` coin=${this.coin} notional=$${this.notional}`,
    );

    // 0. Notional sanity (sync, no API call)
    if (this.notional > 100_000) {
      return `Notional $${this.notional} exceeds safety limit ($100,000) — check bot configuration`;
    }

    // 1. Verify the LONG venue (dYdX) can actually TRADE — not just read.
    //    This runs BEFORE any Hyperliquid order so a missing or broken signer
    //    aborts with zero orders placed.
    //    Public market data (getMarkPrice) works without a wallet, so a mark-price
    //    check is not sufficient here; checkTradingReady() calls ensureClient()
    //    which verifies DYDX_TESTNET_MNEMONIC and initialises the signer.
    try {
      await longVenue.checkTradingReady();
    } catch (e) {
      return (
        `${longVenueId} is not ready for live trading: ${(e as Error).message}. ` +
        `Set DYDX_TESTNET_MNEMONIC in .env to enable cross-venue live orders.`
      );
    }

    // 2. Verify the SHORT venue (HL) can trade and has a mark price
    try {
      await shortVenue.checkTradingReady();
    } catch (e) {
      return `${shortVenueId} is not ready for live trading: ${(e as Error).message}`;
    }

    let shortMark: number | null = null;
    try {
      shortMark = await shortVenue.getMarkPrice(this.coin);
    } catch (e) {
      return `Mark price fetch failed on ${shortVenueId}: ${(e as Error).message}`;
    }
    if (!shortMark) {
      return `No mark price on ${shortVenueId} for ${this.coin} — venue may be unreachable`;
    }

    // 3. Verify the short venue has sufficient available margin for this notional
    let shortAvailable: number | null = null;
    try {
      shortAvailable = shortVenue.getAvailableBalance
        ? await shortVenue.getAvailableBalance()
        : await shortVenue.getAccountEquity();
    } catch (e) {
      return `Could not fetch ${shortVenueId} account balance: ${(e as Error).message}`;
    }
    const balGate = checkBalanceGate(shortAvailable, this.notional, config.risk.balanceGateMaxLeverage);
    if (!balGate.ok) {
      console.warn(`[cross-venue] BALANCE GATE: ${balGate.reason}`);
      return `Balance gate: ${balGate.reason}`;
    }

    // 4. Verify dYdX has a mark price (confirms the coin exists on the long venue too)
    let longMark: number | null = null;
    try {
      longMark = await longVenue.getMarkPrice(this.coin);
    } catch (e) {
      return `Mark price fetch failed on ${longVenueId}: ${(e as Error).message}`;
    }
    if (!longMark) {
      return `No mark price on ${longVenueId} for ${this.coin} — coin may not be listed`;
    }

    console.log(
      `[cross-venue] Pre-flight passed — ` +
      `${shortVenueId} mark=$${shortMark.toFixed(2)} available=$${shortAvailable?.toFixed(2) ?? "?"} ` +
      `${longVenueId} mark=$${longMark.toFixed(2)} notional=$${this.notional}`,
    );
    return null;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private persistState(): void {
    if (!this.stateStore) return;
    this.stateStore.save({
      botId:           this.botId,
      capturedFunding: this.capturedFunding,
      totalFees:       this.totalFees,
      equity:          this.equity,
      periods:         this.periods,
      flipCount:       this.flipCount,
      startedAt:       this.startedAt,
      totalLegHoldMs:  this.totalLegHoldMs,
      lastBucket:      this.lastBucket,
      lastFlipAt:      this.lastFlipAt,
      positioned:      this.positioned,
      shortVenue:      this.shortVenue,
      longVenue:       this.longVenue,
      executionMode:   this.executionMode,
      notional:        this.notional,
      dailyStartEq:    this.dailyStartEquity,
      hourlyAccruals:  this.hourlyAccruals,
    });
  }

  private persistFlipEvent(
    fromShort: string, fromLong: string,
    toShort: string, toLong: string,
    spread: number, fee: number,
  ): void {
    if (!this.stateStore) return;
    this.stateStore.recordFlip({
      botId:       this.botId,
      ts:          Date.now(),
      fromShort, fromLong, toShort, toLong,
      spread, fee,
      equityAfter: this.equity,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private recordHourlyAccrual(bucket: number, totalEarned: number, n: number): void {
    // For multi-bucket advances, spread evenly across each bucket
    const perBucket = totalEarned / n;
    for (let i = n; i >= 1; i--) {
      this.hourlyAccruals.push({ bucket: bucket - (i - 1), earned: perBucket });
    }
    // Keep only the last ROLLING_7D_LEN entries
    if (this.hourlyAccruals.length > ROLLING_7D_LEN) {
      this.hourlyAccruals = this.hourlyAccruals.slice(-ROLLING_7D_LEN);
    }
  }

  private scheduleDailyReset(): void {
    const now      = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const msUntil  = tomorrow.getTime() - now.getTime();

    this.dailyTimer = setTimeout(() => {
      const prevStart   = this.dailyStartEquity;
      this.dailyStartEquity = this.equity;
      const wasCircuitBreaker = this.paused;
      this.paused       = false;
      this.pausedReason = "";
      console.log(
        `[cross-venue] Daily reset — dailyStart=$${this.dailyStartEquity.toFixed(4)}` +
        (wasCircuitBreaker ? " (circuit breaker cleared)" : ""),
      );
      void prevStart; // used in log above
      this.logger?.logEvent("cross-venue", "info", "daily reset", {
        newDailyStart: this.dailyStartEquity,
        circuitBreakerCleared: wasCircuitBreaker,
      });
      this.scheduleDailyReset();
    }, msUntil);
  }
}
