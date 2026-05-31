import type { Venue } from "./venue.js";
import type { BotState } from "./bot-manager.js";
import type { Logger } from "./logger.js";

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

export type ExecutionMode = "paper" | "testnet";

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
  private readonly startedAt = Date.now();

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

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    venueA:     Venue,
    venueB:     Venue,
    coin:       string,
    notionalUsd = 1_000,
    logger?:    Logger,
  ) {
    this.venueA           = venueA;
    this.venueB           = venueB;
    this.coin             = coin;
    this.notional         = notionalUsd;
    this.equity           = notionalUsd;
    this.dailyStartEquity = notionalUsd;
    this.logger           = logger;
    this.rates            = { [venueA.name]: null, [venueB.name]: null };
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
      categoryLabel: `${this.venueA.name.toUpperCase()} ↔ ${this.venueB.name.toUpperCase()} · ${this.executionMode === "testnet" ? "TESTNET" : "paper sim"}`,
      coin:          this.coin,
      timeframe:     "—",
      live:          this.executionMode === "testnet",
      active:        !this.paused,
      status:        this.lastError ? "error" : this.paused ? "paused" : "running",
      equity:        this.equity + partialAccrual,
      unrealisedPnl: partialAccrual,
      lastPrice:     0,
      position:      null,
      sessionPnl:    this.capturedFunding - this.totalFees + partialAccrual,
      tradeCount:    this.periods,
      startedAt:     this.startedAt,
      error:         this.lastError ?? undefined,
      fundingDirection: this.positioned
        ? `${this.shortVenue.toUpperCase()} SHORT / ${this.longVenue.toUpperCase()} LONG`
        : (this.paused ? "PAUSED" : "FLAT — below min spread"),
      fundingFlips:    this.flipCount,
      crossVenueLegs:  this.legs?.map((l) => ({ venue: l.venueId, side: l.side })) ?? [],
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
    if (this.executionMode === "testnet") {
      await this.placeRealOrders("open", shortId, longId);
    }

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
      { shortId, longId, spread, rateA, rateB, fee, executionMode: this.executionMode },
    );
    console.log(
      `[cross-venue] OPENED short ${shortId}(${(shortRate * 100).toFixed(4)}%)` +
      ` long ${longId}(${(longRate * 100).toFixed(4)}%)` +
      ` spread=${(spread * 100).toFixed(4)}%/hr fee=$${fee.toFixed(4)} [${this.executionMode}]`,
    );
  }

  private async flipLegs(
    newShortId: string, newLongId: string, newSpread: number, rateA: number, rateB: number,
  ): Promise<void> {
    if (this.executionMode === "testnet") {
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
    console.log(
      `[cross-venue] FLIPPED to short ${newShortId} long ${newLongId}` +
      ` spread=${(newSpread * 100).toFixed(4)}%/hr held=${Math.round(holdMs / 60_000)}m` +
      ` fee=$${fee.toFixed(4)} (flip #${this.flipCount}) [${this.executionMode}]`,
    );
  }

  // ── Real-order placement ──────────────────────────────────────────────────

  private async placeRealOrders(
    action:       "open" | "close",
    shortVenueId: string,
    longVenueId:  string,
  ): Promise<void> {
    const shortVenue = shortVenueId === this.venueA.name ? this.venueA : this.venueB;
    const longVenue  = longVenueId  === this.venueA.name ? this.venueA : this.venueB;

    let shortTx: string | undefined;
    try {
      const r   = action === "open"
        ? await shortVenue.openPosition(this.coin, "short", this.notional)
        : await shortVenue.closePosition(this.coin);
      shortTx = r.orderId;
      console.log(`[cross-venue] ${action} short on ${shortVenueId} → ${shortTx}`);
    } catch (e) {
      throw new Error(`${action} SHORT on ${shortVenueId} failed: ${(e as Error).message}`);
    }

    try {
      const r   = action === "open"
        ? await longVenue.openPosition(this.coin, "long", this.notional)
        : await longVenue.closePosition(this.coin);
      console.log(`[cross-venue] ${action} long  on ${longVenueId} → ${r.orderId}`);
    } catch (e) {
      console.error(
        `[cross-venue] ⚠ PARTIAL: ${action} SHORT ${shortVenueId}(${shortTx}) OK` +
        ` but LONG ${longVenueId} FAILED: ${(e as Error).message}` +
        ` — manual intervention may be required`,
      );
      throw new Error(
        `${action} LONG on ${longVenueId} failed (short already placed!): ` +
        (e as Error).message,
      );
    }
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
