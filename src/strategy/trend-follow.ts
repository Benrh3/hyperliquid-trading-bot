import { computeEMA } from "./indicators.js";
import type { Strategy } from "./base.js";
import type { Candle, Signal } from "../events.js";
import { coins } from "../config.js";

const MIN_CANDLES = 201;

export class TrendFollowStrategy implements Strategy {
  name = "trend-follow";
  private readonly coin: string;
  private lastEma21:  number | null = null;
  private lastEma55:  number | null = null;
  private lastEma200: number | null = null;
  private signalCount = 0;

  constructor() { this.coin = coins[0]; }

  getState(): Record<string, unknown> {
    return { signalCount: this.signalCount, ema21: this.lastEma21, ema55: this.lastEma55, ema200: this.lastEma200 };
  }

  onCandle(candle: Candle, history: Candle[]): Signal | null {
    if (history.length < MIN_CANDLES) return null;
    const coin = candle.coin ?? this.coin;

    const ema21  = computeEMA(history, { period: 21 }).values;
    const ema55  = computeEMA(history, { period: 55 }).values;
    const ema200 = computeEMA(history, { period: 200 }).values;

    const n = ema21.length;
    if (n < 2) return null;

    const e21c = ema21[n - 1], e21p = ema21[n - 2];
    const e55c = ema55[n - 1], e55p = ema55[n - 2];
    const e200 = ema200[n - 1];

    if (isNaN(e21c) || isNaN(e55c) || isNaN(e200)) return null;

    this.lastEma21 = e21c; this.lastEma55 = e55c; this.lastEma200 = e200;

    const goldenCross = e21p <= e55p && e21c > e55c;
    const deathCross  = e21p >= e55p && e21c < e55c;
    const aboveEma200 = candle.close > e200;

    if (goldenCross) {
      this.signalCount++;
      return aboveEma200
        ? { side: "long",  coin, reason: `EMA21 crossed above EMA55 (${e21c.toFixed(2)}), price above EMA200`, timestamp: Date.now() }
        : { side: "close", coin, reason: `EMA21 crossed above EMA55 but price below EMA200 — exit short`, timestamp: Date.now() };
    }
    if (deathCross) {
      this.signalCount++;
      return !aboveEma200
        ? { side: "short", coin, reason: `EMA21 crossed below EMA55 (${e21c.toFixed(2)}), price below EMA200`, timestamp: Date.now() }
        : { side: "close", coin, reason: `EMA21 crossed below EMA55 but price above EMA200 — exit long`, timestamp: Date.now() };
    }
    return null;
  }
}
