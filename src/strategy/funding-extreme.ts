/**
 * Funding-Extreme strategy for HYPE.
 *
 * Thesis: the HYPE funding rate has a strong mass-point at the protocol default
 * (≈ 1.25e-5 /h). Deviations from this default are therefore meaningful signals:
 * when funding is a large multiple of the default, one side is paying extreme carry;
 * when funding goes negative, longs are paying shorts.
 *
 * Signal: funding_rate (hl-market, dirBearPos).
 * Entry short: funding ≥ defaultRate × entryShortMultiple (longs overpaying carry).
 * Entry long:  funding < entryLongNegative threshold (shorts receiving carry from longs).
 * Exit: |funding − defaultRate| < exitBand (normalised), or max-hold cap,
 *       or stop-loss (applied by the backtest engine, not this class).
 *
 * No rolling window: thresholds are absolute, derived from params alone.
 * Requires backtest-only execution (candles must have signals attached).
 */

import type { Candle, Signal } from "../events.js";
import type { Strategy } from "./base.js";

export const SIGNAL_KEY = "funding_rate";

export interface FundingExtremeParams {
  /** The mass-point protocol default funding rate (≈ 1.25e-5 /h). */
  defaultRate:         number;
  /** Enter short when funding ≥ defaultRate × this multiple. Default 3. */
  entryShortMultiple:  number;
  /** Enter long when funding ≤ this threshold. Default 0 (strictly negative funding). */
  entryLongNegative:   number;
  /** Exit when |funding − defaultRate| < this absolute ε. Default 0.5 × defaultRate. */
  exitBand:            number;
  /** Maximum bars to hold before a forced exit. Default 72 = 3 days at 1h. */
  maxHoldBars:         number;
  /**
   * Stop-loss %.  Stored here so walk-forward can grid-search it.
   * Enforcement is done by the backtest engine; this class does not implement stop-loss.
   */
  stopLossPct:         number;
}

export class FundingExtremeStrategy implements Strategy {
  name = "funding-extreme";

  private side:     "long" | "short" | null = null;
  private entryIdx: number = -1;

  constructor(private readonly params: FundingExtremeParams) {}

  getState(): Record<string, unknown> {
    return {
      side:           this.side,
      shortThreshold: this.params.defaultRate * this.params.entryShortMultiple,
      longThreshold:  this.params.entryLongNegative,
      exitBand:       this.params.exitBand,
    };
  }

  onCandle(candle: Candle, history: Candle[]): Signal | null {
    const rawVal = candle.signals?.[SIGNAL_KEY];
    if (rawVal === undefined || rawVal === null || isNaN(rawVal as number)) return null;
    const sig    = rawVal as number;
    const coin   = candle.coin ?? "HYPE";
    const barIdx = history.length - 1;

    const shortThreshold = this.params.defaultRate * this.params.entryShortMultiple;

    // ── Exit checks (before entries) ─────────────────────────────────────────
    if (this.side !== null) {
      const normalised = Math.abs(sig - this.params.defaultRate) < this.params.exitBand;
      const maxHold    = this.entryIdx >= 0 && (barIdx - this.entryIdx) >= this.params.maxHoldBars;
      if (normalised || maxHold) {
        this.side = null; this.entryIdx = -1;
        return {
          side: "close", coin,
          reason: normalised
            ? `funding ${sig.toExponential(3)} within ε=${this.params.exitBand.toExponential(2)} of default (normalised)`
            : `max-hold ${this.params.maxHoldBars} bars`,
          timestamp: 0,
        };
      }
    }

    // ── Entry checks (only when flat) ────────────────────────────────────────
    if (!this.side) {
      if (sig < this.params.entryLongNegative) {
        this.side = "long"; this.entryIdx = barIdx;
        return {
          side: "long", coin,
          reason: `funding ${sig.toExponential(3)} < ${this.params.entryLongNegative.toExponential(2)} (shorts receiving carry from longs)`,
          timestamp: 0,
        };
      }
      if (sig >= shortThreshold) {
        this.side = "short"; this.entryIdx = barIdx;
        return {
          side: "short", coin,
          reason: `funding ${sig.toExponential(3)} ≥ ${shortThreshold.toExponential(2)} (${this.params.entryShortMultiple}× default, longs overpaying carry)`,
          timestamp: 0,
        };
      }
    }

    return null;
  }
}
