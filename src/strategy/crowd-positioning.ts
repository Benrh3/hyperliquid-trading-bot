/**
 * Crowd-positioning continuation strategy for HYPE.
 *
 * Signal: lsr_agg_long_frac (Aggregate Long %, dirBearHigh).
 * When crowd is most short (low signal) → structural bid drives price up → long.
 * When crowd is most long  (high signal) → mean-reversion / short-squeeze → short.
 *
 * Requires backtest-only execution (candles must have signals attached).
 */

import type { Candle, Signal } from "../events.js";
import type { Strategy } from "./base.js";

export const SIGNAL_KEY = "lsr_agg_long_frac";

export interface CrowdPositioningParams {
  /** Entry long below this percentile value (e.g. p20 of signal window). */
  entryLongBelow:  number;
  /** Entry short above this percentile value (e.g. p80 of signal window). */
  entryShortAbove: number;
  /** Exit when signal reverts past this midpoint toward neutral. Defaults to midpoint of the two thresholds. */
  exitNeutral:     number;
  /** Maximum bars to hold before force-exit. Default 48 (2 days at 1h). */
  maxHoldBars:     number;
}

export class CrowdPositioningStrategy implements Strategy {
  name = "crowd-positioning";

  private entryLongBelow:  number;
  private entryShortAbove: number;
  private exitNeutral:     number;
  private maxHoldBars:     number;

  private side:     "long" | "short" | null = null;
  private entryIdx: number = -1;

  constructor(params: CrowdPositioningParams) {
    this.entryLongBelow  = params.entryLongBelow;
    this.entryShortAbove = params.entryShortAbove;
    this.exitNeutral     = params.exitNeutral;
    this.maxHoldBars     = params.maxHoldBars;
  }

  getState(): Record<string, unknown> {
    return {
      side:            this.side,
      entryLongBelow:  this.entryLongBelow,
      entryShortAbove: this.entryShortAbove,
      exitNeutral:     this.exitNeutral,
      maxHoldBars:     this.maxHoldBars,
    };
  }

  onCandle(candle: Candle, history: Candle[]): Signal | null {
    const rawVal = candle.signals?.[SIGNAL_KEY];
    if (rawVal === undefined || rawVal === null || isNaN(rawVal as number)) return null;
    const sig  = rawVal as number;
    const coin = candle.coin ?? "HYPE";
    const barIdx = history.length - 1;

    // ── Exit: directional, then max-hold cap ───────────────────────────
    if (this.side === "long") {
      const neutral  = sig >= this.exitNeutral;
      const maxHold  = this.entryIdx >= 0 && (barIdx - this.entryIdx) >= this.maxHoldBars;
      if (neutral || maxHold) {
        this.side = null; this.entryIdx = -1;
        return { side: "close", coin,
          reason: neutral ? `lsr ${sig.toFixed(3)} ≥ neutral ${this.exitNeutral.toFixed(3)}`
                          : `max-hold ${this.maxHoldBars} bars`,
          timestamp: 0 };
      }
    }

    if (this.side === "short") {
      const neutral  = sig <= this.exitNeutral;
      const maxHold  = this.entryIdx >= 0 && (barIdx - this.entryIdx) >= this.maxHoldBars;
      if (neutral || maxHold) {
        this.side = null; this.entryIdx = -1;
        return { side: "close", coin,
          reason: neutral ? `lsr ${sig.toFixed(3)} ≤ neutral ${this.exitNeutral.toFixed(3)}`
                          : `max-hold ${this.maxHoldBars} bars`,
          timestamp: 0 };
      }
    }

    // ── Entry: only when flat ──────────────────────────────────────────
    if (!this.side) {
      if (sig < this.entryLongBelow) {
        this.side = "long"; this.entryIdx = barIdx;
        return { side: "long", coin,
          reason: `lsr ${sig.toFixed(3)} < p20 ${this.entryLongBelow.toFixed(3)} (crowd short)`,
          timestamp: 0 };
      }
      if (sig > this.entryShortAbove) {
        this.side = "short"; this.entryIdx = barIdx;
        return { side: "short", coin,
          reason: `lsr ${sig.toFixed(3)} > p80 ${this.entryShortAbove.toFixed(3)} (crowd long)`,
          timestamp: 0 };
      }
    }

    return null;
  }
}
