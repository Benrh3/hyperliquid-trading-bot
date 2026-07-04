/**
 * Funding-Extreme strategy for HYPE.
 *
 * Thesis: when HYPE funding is at an extreme percentile of its own recent
 * history the crowded side is paying a carry headwind and is structurally
 * fragile — enter against it, collect funding, exit on normalisation.
 *
 * Signal: funding_rate (hl-market, dirBearPos).
 * Entry short: funding > p90 of trailing window (longs overpaying carry).
 * Entry long:  funding < p10 of trailing window (shorts overpaying carry).
 * Exit: funding reverts inside the p40–p60 neutral band, or max-hold cap,
 *       or stop-loss (applied by the backtest engine, not this class).
 *
 * Point-in-time guarantee: percentile at bar T is computed from at most
 * trailingWindowBars values, all with capturedAt ≤ closeTime(T).  The window
 * is built by pushing one value per bar in order — future bars are structurally
 * unreachable.  Do NOT replace sigHistory with a full-series sort; that would
 * be the soft-lookahead pattern used in the crowd-positioning calibration
 * script and explicitly avoided here.
 *
 * Requires backtest-only execution (candles must have signals attached).
 */

import type { Candle, Signal } from "../events.js";
import type { Strategy } from "./base.js";

export const SIGNAL_KEY = "funding_rate";

/** Minimum bars in the rolling window before the strategy makes any entry. */
const MIN_WINDOW = 24;

// ── Percentile utility ────────────────────────────────────────────────────────

/**
 * Linear-interpolation percentile of a pre-sorted ascending array.
 * p is in [0, 1].  Returns NaN for an empty array.
 *
 * Exported so tests can verify correctness independently of the strategy.
 */
export function computePercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── Params ────────────────────────────────────────────────────────────────────

export interface FundingExtremeParams {
  /** Percentile (0–1). Enter long when funding is below this. Default 0.10 = p10. */
  entryLongBelow:     number;
  /** Percentile (0–1). Enter short when funding is above this. Default 0.90 = p90. */
  entryShortAbove:    number;
  /** Lower edge of the neutral exit band (0–1). Default 0.40 = p40. */
  exitBandLow:        number;
  /** Upper edge of the neutral exit band (0–1). Default 0.60 = p60. */
  exitBandHigh:       number;
  /** Number of bars in the rolling window. Default 720 = 30 days × 24h. */
  trailingWindowBars: number;
  /** Maximum bars to hold before a forced exit. Default 72 = 3 days at 1h. */
  maxHoldBars:        number;
  /**
   * Stop-loss %.  Stored here so walk-forward can grid-search it.
   * Enforcement is done by the backtest engine (runBacktest stopLossPct param);
   * this class does not implement stop-loss logic itself.
   */
  stopLossPct:        number;
}

// ── Strategy ──────────────────────────────────────────────────────────────────

export class FundingExtremeStrategy implements Strategy {
  name = "funding-extreme";

  // Rolling window of past funding values (point-in-time: built bar-by-bar)
  private sigHistory: number[] = [];

  // Current computed percentile thresholds (updated every bar)
  private p10 = NaN;
  private p90 = NaN;
  private p40 = NaN;
  private p60 = NaN;

  private side:     "long" | "short" | null = null;
  private entryIdx: number = -1;

  constructor(private readonly params: FundingExtremeParams) {}

  getState(): Record<string, unknown> {
    return {
      side:           this.side,
      p10:            this.p10,
      p90:            this.p90,
      p40:            this.p40,
      p60:            this.p60,
      windowSize:     this.sigHistory.length,
      windowCapacity: this.params.trailingWindowBars,
    };
  }

  onCandle(candle: Candle, history: Candle[]): Signal | null {
    const rawVal = candle.signals?.[SIGNAL_KEY];
    if (rawVal === undefined || rawVal === null || isNaN(rawVal as number)) return null;
    const sig  = rawVal as number;
    const coin = candle.coin ?? "HYPE";
    const barIdx = history.length - 1;

    // ── 1. Extend rolling window (point-in-time: current bar is now known) ──
    this.sigHistory.push(sig);
    if (this.sigHistory.length > this.params.trailingWindowBars) {
      this.sigHistory.shift();
    }

    // Require a minimum of data before the first entry
    if (this.sigHistory.length < MIN_WINDOW) return null;

    // ── 2. Recompute thresholds from trailing window ──────────────────────
    const sorted = [...this.sigHistory].sort((a, b) => a - b);
    this.p10 = computePercentile(sorted, this.params.entryLongBelow);
    this.p90 = computePercentile(sorted, this.params.entryShortAbove);
    this.p40 = computePercentile(sorted, this.params.exitBandLow);
    this.p60 = computePercentile(sorted, this.params.exitBandHigh);

    // ── 3. Exit checks (before entries) ──────────────────────────────────
    if (this.side === "long") {
      const normalized = sig >= this.p40;
      const maxHold    = this.entryIdx >= 0 && (barIdx - this.entryIdx) >= this.params.maxHoldBars;
      if (normalized || maxHold) {
        this.side = null; this.entryIdx = -1;
        return { side: "close", coin,
          reason: normalized
            ? `funding ${sig.toExponential(3)} ≥ p${Math.round(this.params.exitBandLow * 100)} ${this.p40.toExponential(3)} (normalised)`
            : `max-hold ${this.params.maxHoldBars} bars`,
          timestamp: 0 };
      }
    }

    if (this.side === "short") {
      const normalized = sig <= this.p60;
      const maxHold    = this.entryIdx >= 0 && (barIdx - this.entryIdx) >= this.params.maxHoldBars;
      if (normalized || maxHold) {
        this.side = null; this.entryIdx = -1;
        return { side: "close", coin,
          reason: normalized
            ? `funding ${sig.toExponential(3)} ≤ p${Math.round(this.params.exitBandHigh * 100)} ${this.p60.toExponential(3)} (normalised)`
            : `max-hold ${this.params.maxHoldBars} bars`,
          timestamp: 0 };
      }
    }

    // ── 4. Entry checks (only when flat) ─────────────────────────────────
    if (!this.side) {
      if (sig < this.p10) {
        this.side = "long"; this.entryIdx = barIdx;
        return { side: "long", coin,
          reason: `funding ${sig.toExponential(3)} < p${Math.round(this.params.entryLongBelow * 100)} ${this.p10.toExponential(3)} (shorts overpaying carry)`,
          timestamp: 0 };
      }
      if (sig > this.p90) {
        this.side = "short"; this.entryIdx = barIdx;
        return { side: "short", coin,
          reason: `funding ${sig.toExponential(3)} > p${Math.round(this.params.entryShortAbove * 100)} ${this.p90.toExponential(3)} (longs overpaying carry)`,
          timestamp: 0 };
      }
    }

    return null;
  }
}
